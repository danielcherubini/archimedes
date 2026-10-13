import { useEffect, useMemo, useRef } from "react";
import {
  attentionActivityStep,
  attentionAlertText,
  attentionStep,
  type AttentionEffect,
  type AttentionLabelContext,
  type AttentionMemory,
  type AttentionSnapshot,
} from "../lib/attention";
import { attentionArm, attentionDisarm } from "../lib/tauri";
import { childGateKey, childGatesOf } from "./useChildGates";
import { isInteractivePause, useInteractive } from "../store/interactive";
import { usePermissions } from "../store/permissions";
import { useSessions } from "../store/sessions";
import { useSettings } from "../store/settings";
import { useSubagents } from "../store/subagents";

/**
 * The attention-alert shell (ADR 0038/0039) — the ONLY impure half of the
 * feature. Every rule (which pause is the candidate, what evidence an armed
 * countdown needs, when the renderer forgets a countdown, what the alert says)
 * lives in `lib/attention.ts`; this file only reads the stores, builds the
 * `AttentionSnapshot`, runs the step, and issues the two commands.
 *
 * The protocol is ONE-WAY — Rust never reports back — so the memory of "an
 * alert was asked for" lives here, in a ref: `armedExpiresAt` is how the
 * renderer retires its own countdown (rule R2) and `spent` is the one-shot that
 * makes an alert fire once per pause, with R4 forgetting it when the pause ends
 * so the NEXT pause alerts. A ref, never a module singleton: a second webview
 * must not inherit the first's memory.
 *
 * Two invariants the whole design rests on, both living in the pure rule and
 * both easy to break from here, so they are restated at the call site:
 *
 * 1. **Never re-arm on an unrelated store write.** A `settled` trigger is a
 *    one-snapshot pulse, so most passes over a live countdown have no candidate
 *    at all — and re-arming anyway would push Rust's deadline out on every
 *    token stream, so the alert would never arrive (and each write would pay an
 *    IPC for it). The pass that has nothing to say sends NOTHING.
 * 2. **Idle input costs zero IPC.** The activity handler asks the pure step
 *    first, and `attentionActivityStep` yields `none` when nothing is armed —
 *    so typing in a quiet window crosses no IPC at all (ADR 0039's whole reason
 *    for existing).
 *
 * A third invariant is a fact about the platform rather than the rule, and the
 * hook is the only place it can be honoured: **a reload runs no cleanup**, so
 * the FIRST thing any renderer does is disarm the countdown a previous one may
 * have left ringing. The unmount cleanup below covers real unmounts only.
 */

/** One failure path for every command: a notification that cannot be booked
 * must never break the chat, and must never reject unhandled either. */
const logFailure = (e: unknown) => console.error("attention alert failed:", e);

/** The delay used when the settings document has no value for it (a
 * pre-feature `settings.json` read through a stale frontend). Mirrors the
 * backend's `default_attention_delay_secs`. */
const DEFAULT_DELAY_SECS = 15;

/**
 * Issue ONE pass's command. The pass path is the ONLY one that can arm (the
 * activity path can only ever disarm or do nothing), and it arms at most once:
 * `attentionStep` returns a single effect, and `arm` subsumes `disarm` because
 * Rust holds one pending countdown that arming already replaces.
 */
function runPass(
  effect: AttentionEffect,
  delaySecs: number,
  ctx: AttentionLabelContext,
): void {
  if (effect.type === "none") return;
  if (effect.type === "disarm") {
    void attentionDisarm().catch(logFailure);
    return;
  }
  const { title, body } = attentionAlertText(effect.trigger, ctx);
  // The delay travels with the arm and is then FORGOTTEN here: Rust owns the
  // clock, so a later settings change must not re-time a running countdown.
  void attentionArm(delaySecs, title, body).catch(logFailure);
}

/**
 * The attention alert's arm/disarm shell. Returns nothing: it owns no state
 * the UI renders, only the ref the countdown's memory lives in.
 */
export function useAttentionAlert(): void {
  // Selectors return the STORE's own values — never a `?? {}` fallback inside a
  // selector, which would mint a fresh object per call and re-render forever
  // (the standing hazard `useSessionStatus.ts` documents). Defaults, where
  // needed, live outside the selector.
  const sessions = useSessions((s) => s.sessions);
  const inTurn = useSessions((s) => s.inTurn);
  const stopReasons = useSessions((s) => s.stopReasons);
  const stalledMap = useSessions((s) => s.stalled);
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const historySessions = useSessions((s) => s.historySessions);
  const prompts = usePermissions((s) => s.prompts);
  const requests = useInteractive((s) => s.requests);
  const subagentEntries = useSubagents((s) => s.entries);
  const settings = useSettings((s) => s.settings);

  // The snapshot is assembled OUTSIDE every selector (a selector that built it
  // would mint a new object on every store write). The candidate ORDER is the
  // hook's job; the pure rule only ever reads that order, left to right.
  const snapshot = useMemo<AttentionSnapshot>(() => {
    const candidateOrder: string[] = [];
    const push = (id: string | null) => {
      if (id !== null && !candidateOrder.includes(id)) candidateOrder.push(id);
    };
    // Active session first, then live MAIN sessions in store order, then the
    // PARENT of every live `SubagentEntry` (`push` dedupes): the pause the user
    // is looking at outranks one they have scrolled away from. A child's gate is
    // answered in its parent's transcript, so it rides at the PARENT's rank —
    // child ids never enter this list. Registering the parent explicitly is not
    // redundant with "live main sessions": `historySessions` never enters
    // `candidateOrder`, and `attentionCandidates` visits ONLY the ids listed
    // there, so a parent registered by nothing would make every child of a
    // Session the user navigated away from — this feature's motivating case —
    // permanently unannounceable.
    push(activeSessionId);
    for (const s of sessions) push(s.sessionId);
    for (const entry of Object.values(subagentEntries)) push(entry.parentSessionId);

    const waitingIds: Record<string, string[]> = {};
    const gate = (id: string, gateId: string) => {
      (waitingIds[id] ??= []).push(gateId);
    };
    // `gateId` is OPAQUE to the pure rule (equality and membership only, see
    // `sameAttentionTrigger` / `pauseOver`), which is what lets a child's gate be
    // keyed to its parent with no change to `lib/attention.ts`.
    //
    // A CHILD's gate therefore carries the COMPOSITE id `childSessionId:requestId`
    // (`childGateKey`, the same string the React list keys use), never the bare
    // `requestId`. That is load-bearing: trigger identity is
    // `(kind, sessionId, gateId)` (`sameAttentionTrigger`, over
    // `AttentionTrigger`), and once the sessionId half is the shared PARENT, two
    // children answering to the same recurring gateway tool-call id (`call_0` —
    // `AttentionTrigger`'s own doc comment says ids recur per response) would
    // collapse into ONE trigger, and after the
    // first was announced `spent` would mute the survivor forever.
    //
    // A parent's OWN gate keeps its bare `requestId`, and the two shapes cannot
    // collide — but say the reason the right way round, because it is the ONLY
    // thing standing between this composite and someone "simplifying" it away.
    // It is NOT that a session id contains a `:` (it does not: `mint_session_id`
    // is `arch_<uuid v4>` in `src-tauri/src/agent/types.rs`, pinned by the
    // `mint_session_id_format` test in `src-tauri/src/agent/session/mod.rs`),
    // and it is NOT that a bare id has no `:` (it can: the sudo flow derives
    // `{toolCallId}:confirm` / `{toolCallId}:password` and emits THOSE as the
    // `requestId`, in the sudo prompt flow in
    // `src-tauri/src/agent/interactive/mod.rs`). The reason is the PREFIX: for a
    // parent's own gate id to be read as
    // a child's, that id would have to begin with a WHOLE minted child session id
    // (`arch_` + a UUID v4) followed by `:` — and a parent's ids are a provider-
    // minted tool-call id, optionally with a `:confirm` / `:password` suffix,
    // which never carries an `arch_<uuid>` prefix. That is the invariant to
    // preserve; do not restate it as "session ids contain colons".
    //
    // ORDER within one parent's array, i.e. the order its pauses are announced
    // in (ADR 0040's within-Session arrival rule). Filling this in a single pass
    // over `Object.entries(requests)` would use KEY-INSERTION order, so a child's
    // gate would land BEFORE the parent's own whenever the child's key was
    // inserted first — a silent inversion of that rule. Hence two passes:
    //
    // 1. every NON-child session's gates — `requests` to completion, THEN
    //    `prompts`, so a parent's own `ask` *and* its own Permission prompt both
    //    outrank any of its children's gates;
    // 2. the child gates after that, in `childGatesOf` order, grouped by parent.
    //    Deliberately re-using the ONE `childGatesOf` derivation rather than
    //    hand-rolling a second ordering over `Object.entries`: it keeps ONE
    //    definition of child arrival order, and it survives `dismissSession`
    //    DELETING a session's key (`store/interactive.ts`), which a
    //    key-order sort would read as "arrived last" and flip a sibling's rank
    //    on.
    //
    // Across two children of one parent the rank is therefore
    // `(childStartedAt, request arrival)` — e.g. child A asks t1, child B asks t2,
    // A asks t3 gives `A:t1, B:t2, A:t3`. The stores hold no cross-child arrival
    // stamp, so that IS the defined rule, not an approximation of the true
    // wall-clock interleave.
    //
    // The `method` filter is `isInteractivePause` — the ONE predicate the whole
    // cue family shares (`childGatesOf`, `sessionStatusOf`, and
    // `useHasPendingRequest` read the same function) — kept even though the union
    // has only its three members: a future method that is not a pause on the user
    // must not start announcing itself. No `?? {}` on the maps: they are the
    // stores' own, always present.
    const isChild = (id: string) => subagentEntries[id] !== undefined;
    for (const [id, list] of Object.entries(requests)) {
      if (isChild(id)) continue;
      for (const r of list) {
        if (isInteractivePause(r.method)) gate(id, r.requestId);
      }
    }
    for (const [id, list] of Object.entries(prompts)) {
      if (isChild(id)) continue;
      for (const p of list) gate(id, p.requestId);
    }
    for (const g of childGatesOf(subagentEntries, requests, prompts, null)) {
      gate(g.parentSessionId, childGateKey(g));
    }

    // The stalled map's values ARE optional (`handleSessionClosed` clears the
    // flag by setting `undefined` rather than deleting the key), hence `!!`.
    const stalled: Record<string, boolean> = {};
    for (const [id, info] of Object.entries(stalledMap)) {
      stalled[id] = !!info;
    }

    // Three accepted consequences of speaking of a child's gate as its parent's,
    // all falling out of R3's evidence arms in `attentionStep` now reading the
    // PARENT's flags for a child trigger (the `next.stalled[id]` and
    // `!next.candidateOrder.includes(id)` clauses):
    //
    // - A STALLED parent disarms (and R5 immediately re-arms) a still-open child
    //   countdown — and NOT once. `attentionStep` is stateless per pass and R3's
    //   stall clause has no latch, so while `stalled[parent]` stays true (Rust
    //   clears it only on a resume or a close) EVERY pass whose deps changed
    //   re-arms the same trigger with a fresh `armedExpiresAt = now + delay`, and
    //   Rust restarts its clock on every `arm`. The consequence is therefore
    //   STARVATION, not one lost second: the alert that would tell the user about
    //   a child parked on an `ask` while its parent's Worker crashed
    //   (`handle_crash` marks the parent stalled and runs the pending-modal cleanup
    //   for the crashed session alone — `handle_crash` → `cleanup_pending_modals` in
    //   `src-tauri/src/agent/session/router.rs`;
    //   a child's gates are NOT closed by its parent's crash) can be pushed back
    //   indefinitely by unrelated churn in other Sessions, and fires only after
    //   `delaySecs` of total dependency quiet. Accepted, and pinned by
    //   `re-times the SAME child countdown on EVERY pass …`; the mechanism
    //   predates this branch (it is R3's kind-agnostic stall clause, whose cost
    //   `attentionStep` documents for a Session's OWN gate) — what the
    //   re-key did is extend its blast radius to every child gate.
    // - Because the gate is keyed to the PARENT, a child's OWN `stalled` flag no
    //   longer reaches its gate's evidence at all (R3 reads the parent's) — and the
    //   Rust crash cleanup the reader would reach for as the backstop does NOT fire
    //   for a Subagent session. `cleanup_pending_modals` opens
    //   `live.get(session_id) else { return }` and the ONLY insert into `live` is on
    //   the main-session start/resume path (`establish_worker_session` in
    //   `src-tauri/src/agent/session/mod.rs`), so a child has no `live` entry; and
    //   `route_event` tracks a child's relayed modal ids under the DELIVERY id — the
    //   PARENT (the pump's `delivery_id` in `src-tauri/src/agent/worker/manager.rs`) —
    //   so a close frame that IS emitted carries `sessionId = parent` and lands in
    //   `App.tsx`'s `interactive-request-close` listener as
    //   `removeRequest(parent, <the child's request id>)`, which changes nothing on
    //   the child's slice. That mis-keying is a known upstream defect with a
    //   follow-up outstanding (ADR 0040's amendment records it). So a CRASHED
    //   CHILD's open `ask` / Permission prompt is NOT auto-closed today: the card
    //   stays on screen. The DELEGATION still resolves — on the Worker's own exit
    //   for a crash, or at the 30-minute `settle_timeout`
    //   (`DEFAULT_SUBAGENT_SETTLE_TIMEOUT`, `src-tauri/src/agent/worker/manager.rs`)
    //   for a child parked on an unanswered gate — but no close frame reaches the
    //   gate either way. The only Rust close frame that DOES reach a
    //   child's slice is `SudoPromptCleanup`'s
    //   (`src-tauri/src/agent/interactive/sudo_exec.rs`) — and only for a DROPPED
    //   sudo flow (a cancel), and only for `confirm` / `password`. What the JS side
    //   guarantees is therefore narrower than it looks, and it is the whole
    //   guarantee: the countdown is disarmed ONLY when the gate leaves
    //   `waitingIds[parent]` (R3's MEMBERSHIP arm — `App.tsx`'s
    //   `interactive-request-close` listener calling `removeRequest`, or an answer).
    //   Pinned by
    //   `only the gate leaving waitingIds disarms it — the CHILD's own stall disarms
    //   nothing`, which MANUFACTURES that removal: it pins the Client's reaction to
    //   the gate going away, not a promise that Rust emits the frame.
    // - A child whose `SubagentEntry` disappears stops being announced — and that
    //   is UNCHANGED behaviour, only a moved mechanism: the snapshot then no
    //   longer recognises the id as a child, so the gate keys back to
    //   `waitingIds[childId]`, and `childId` is absent from `candidateOrder` both
    //   before this change (it was pushed from `subagentEntries`, which just lost
    //   the key) and after (only parents of LIVE entries are pushed). So
    //   `attentionCandidates` never visits it and R3's membership arm disarms
    //   either way. Note the asymmetry with `childGatesOf`, which DROPS
    //   the same gate: a card needs a parent transcript to sit in, whereas the
    //   alert can still name an owner it cannot resolve.
    //
    // And one inherited hole, pre-existing in shape: `deleteSession`
    // (`store/sessions.ts`) drops the parent from every session list but
    // clears neither its children's entries nor their gates, so a parent pushed
    // into `candidateOrder` above can still arm `"A session needs your answer"`
    // for a deleted Session. The child-keyed shape armed `"A session"` too;
    // accepted.
    return {
      candidateOrder,
      // Live main sessions ONLY — also the liveness test that retires a
      // "finished" alert when the Session is paused or closed. UNCHANGED by the
      // re-key, and `attentionCandidates`' `settledWatch` skip — "a subagent
      // finishing is not the user's pause" — keeps
      // working for free now that no child id ever reaches `candidateOrder`.
      settledWatch: sessions.map((s) => s.sessionId),
      inTurn,
      stopReasons,
      // A key appears only when it has at least one gate (never an empty array).
      waitingIds,
      stalled,
    };
  }, [
    sessions,
    inTurn,
    stopReasons,
    stalledMap,
    activeSessionId,
    subagentEntries,
    prompts,
    requests,
  ]);

  // `=== true` is the fail-safe FORM: an absent or `undefined` field means OFF,
  // the same direction as the `#`-mention gate's `?? false` in `ChatStream`. It
  // also makes `settings === null` (still loading) mean disabled with NO
  // buffering: live Sessions do not survive a restart, so a settled pulse can
  // only follow a user send — far later than boot — hence no reachable pulse is
  // lost while the document is in flight.
  const enabled = settings?.attentionAlertsEnabled === true;
  const delaySecs = settings?.attentionAlertDelaySecs ?? DEFAULT_DELAY_SECS;

  const prevRef = useRef<AttentionSnapshot | null>(null);
  const memoryRef = useRef<AttentionMemory>({
    armed: null,
    armedExpiresAt: null,
    spent: [],
  });

  // Boot: cancel whatever the previous renderer left counting. A page reload
  // runs NO React cleanup (ADR 0039 says so outright) — so the disarm in the
  // listener effect's cleanup below CANNOT cover one. Reload with a countdown
  // armed and the Supervisor keeps counting, fires up to `delaySecs` later with
  // text describing a Session the new renderer knows nothing about, and cannot
  // be stopped from here: this ref starts `armed: null`, so
  // `attentionActivityStep` yields `none` and the user's own typing sends
  // nothing. Their deliberate input is powerless against it; only this call can
  // reach the orphan.
  //
  // DECLARATION ORDER IS THE ORDERING MECHANISM. React runs a component's
  // effects in declaration order on mount, so sitting ABOVE the pass effect is
  // what guarantees boot is disarm-then-arm. Declared below it, this would
  // cancel the countdown the pass effect had just booked for a gate that was
  // already open — and the memory would still claim it is armed, which R5
  // respects by never re-arming it, so the alert would be silently dead. Moving
  // this effect is therefore not a style change: BOTH mount tests fail the moment
  // it is declared below the pass effect (transcript `arm, disarm`, and the last
  // thing Rust hears under StrictMode is a disarm).
  //
  // Unconditional, and free: `attention_disarm` is a `take()` on Rust's single
  // slot, so booting with nothing counting costs one no-op IPC. And `armed` is
  // `null` here by construction (a fresh ref), so this can never cancel this
  // renderer's own countdown — the only thing it can hit is an orphan's.
  useEffect(() => {
    void attentionDisarm().catch(logFailure);
  }, []);

  useEffect(() => {
    const { effect, memory } = attentionStep(
      memoryRef.current,
      prevRef.current,
      snapshot,
      {
        enabled,
        // Monotonic, never `Date.now()`: a wall-clock step (suspend/resume, NTP
        // correction) would retire the memory while Rust's monotonic countdown
        // is still live, and an armed countdown could then no longer be
        // disarmed by activity. `performance.now()` exists in both the webview
        // and jsdom, so the tests need no shim.
        now: performance.now(),
        delaySecs,
      },
    );
    prevRef.current = snapshot;
    memoryRef.current = memory;

    // The label names the state the decision was made on, so it is read from
    // THIS render's selectors — the same ones the snapshot was built from. A
    // selected value can never be stale here: any write to it re-renders this
    // component, so the render whose deps changed (and whose effect therefore
    // runs) holds the current one — and a write that changes NO dep issues no
    // command at all, so a never-re-run closure can never speak.
    //
    // `SubagentEntry.parentSessionId` is the ONLY parent source (`useSubagents`
    // is its sole holder), so a gate whose parent is absent from
    // `sessions`/`historySessions` labels `"A session"` — accepted, no second
    // parent map.
    //
    // THIS MAP IS NOW A NO-OP FOR A CHILD'S GATE, AND MUST STAY. The snapshot
    // re-keys a child's gate to its PARENT, so `trigger.sessionId` already holds
    // the parent id: the `ctx.parents[trigger.sessionId]` lookup in
    // `attentionAlertText` MISSES and falls through to the id itself — which is
    // already the parent, so the
    // body still names it. Do NOT "clean up" this map: the interface still
    // requires the field, `lib/attention.test.ts` still exercises the child-id
    // path directly, and the fall-through is what keeps the alert naming the
    // parent (pinned by `arms for a subagent's gate …, naming the PARENT`).
    const parents: Record<string, string> = {};
    for (const [id, entry] of Object.entries(subagentEntries)) {
      parents[id] = entry.parentSessionId;
    }
    runPass(effect, delaySecs, {
      sessions: [...sessions, ...historySessions],
      parents,
    });
    // The dep array is EXACTLY the three values the rule reads. The label's
    // sources are deliberately absent: an effect always runs with the closure of
    // the render whose deps changed, and any write to `sessions` / `historySessions`
    // / `entries` re-renders this component anyway (all three are selected), so
    // the label is never stale — while adding them would run an extra pass for a
    // value no rule reads (e.g. a re-titled stored session).
  }, [snapshot, enabled, delaySecs]);

  useEffect(() => {
    const onActivity = (event: Event) => {
      // `event.target` is `window` for a window-dispatched event and `Window`
      // has no `closest` — an optional chain on the target alone would throw.
      const el = event.target instanceof Element ? event.target : null;
      // The window's own controls are NOT attention: "run finishes → click
      // Minimize → walk away" is this feature's main use case (ADR 0038).
      if (el?.closest("[data-window-control]")) return;
      const { effect, memory } = attentionActivityStep(memoryRef.current);
      memoryRef.current = memory;
      // `attentionActivityStep` can only ever yield `disarm` or `none` — it can
      // never arm — so this handler needs no settings values and holds no ref to
      // them, and an idle window sends nothing.
      if (effect.type === "disarm") void attentionDisarm().catch(logFailure);
    };
    const capture = { capture: true } as const;
    // CAPTURE is load-bearing: `ChatStream` owns a window `keydown` handler and
    // Radix dialogs stop propagation, so a bubbling listener would miss activity
    // inside a modal — exactly where a Permission prompt sits.
    window.addEventListener("keydown", onActivity, capture);
    window.addEventListener("pointerdown", onActivity, capture);
    window.addEventListener("wheel", onActivity, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener("keydown", onActivity, capture);
      window.removeEventListener("pointerdown", onActivity, capture);
      window.removeEventListener("wheel", onActivity, capture);
      // A REAL UNMOUNT (the component going away inside a live page) is what
      // this covers, and nothing more: a webview reload runs no cleanup at all,
      // which is exactly why the mount effect above disarms unconditionally.
      //
      // StrictMode's double-invoked mount/unmount does not make this unsafe, and
      // the reason is a fact about boot rather than a guarantee of this code: a
      // real boot has NO live Sessions (they do not survive a restart), so there
      // is no pulse and no gate for this to disarm. The honest claim is that
      // narrow — it is NOT true that nothing can be armed here. With a gate
      // already open (Fast Refresh, or StrictMode over a Session holding a
      // question) the sequence is DISARM, ARM, DISARM, DISARM, ARM: this cleanup
      // does disarm a live countdown and the re-mount re-arms from the same
      // evidence, so the end state is ARMED — the intended one — and the
      // transient disarms cost redundant IPC, not a lost alert.
      if (memoryRef.current.armed !== null) {
        memoryRef.current = { ...memoryRef.current, armed: null, armedExpiresAt: null };
        void attentionDisarm().catch(logFailure);
      }
    };
  }, []);
}
