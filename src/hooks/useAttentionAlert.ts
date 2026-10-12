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
import { useInteractive } from "../store/interactive";
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
    // Active session first, then live MAIN sessions in store order, then
    // subagent ids: the pause the user is looking at outranks one they have
    // scrolled away from, and a subagent's gate ranks last (its parent is still
    // in turn, so it is never `settled` — `settledWatch` above).
    push(activeSessionId);
    for (const s of sessions) push(s.sessionId);
    for (const id of Object.keys(subagentEntries)) push(id);

    const waitingIds: Record<string, string[]> = {};
    const gate = (id: string, gateId: string) => {
      (waitingIds[id] ??= []).push(gateId);
    };
    // Interactive gates FIRST, then permission prompts: EVERY entry of the array
    // is a candidate in this order, so this is also the order they are announced
    // in (a second question from the same session ranks after the first).
    // The `method` filter is kept even though the union has only these three
    // (the same filter `sessionStatusOf` applies) — a future method that is not
    // a pause on the user must not start announcing itself. No `?? {}` on the
    // maps: they are the stores' own, always present.
    for (const [id, list] of Object.entries(requests)) {
      for (const r of list) {
        if (r.method === "ask" || r.method === "confirm" || r.method === "password") {
          gate(id, r.requestId);
        }
      }
    }
    for (const [id, list] of Object.entries(prompts)) {
      for (const p of list) gate(id, p.requestId);
    }

    // The stalled map's values ARE optional (`handleSessionClosed` clears the
    // flag by setting `undefined` rather than deleting the key), hence `!!`.
    const stalled: Record<string, boolean> = {};
    for (const [id, info] of Object.entries(stalledMap)) {
      stalled[id] = !!info;
    }

    return {
      candidateOrder,
      // Live main sessions ONLY — also the liveness test that retires a
      // "finished" alert when the Session is paused or closed.
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
