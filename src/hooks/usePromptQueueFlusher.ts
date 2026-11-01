import type { RefObject } from "react";
import { describeIpcError } from "../lib/ipcError";
import { readAttachmentAsBase64, releaseAttachment } from "../lib/chatAttachments";
import { useSessions } from "../store/sessions";
import { useQueuedPrompts } from "../store/queuedPrompts";
import type { SendTextImages, UseChatPromptDispatchResult } from "./useChatPromptDispatch";

/**
 * The **Prompt queue**'s **Flush** (issue #135 §2, ADR 0069): `flushHead` — the
 * body that sends the queue's head as an ordinary prompt — plus the render-phase
 * `flushRef.current` assignment, both MOVED VERBATIM out of `ChatStream.tsx`
 * with their load-bearing comments. Nothing here is improved.
 *
 * THE TRIGGER IS SPLIT IN TWO, and both halves stay visible here:
 *  - part 1 is `useSessionIdleEdge`, which stays in `ChatStream` (it is a hook,
 *    so it must sit in the component's unconditional block above the
 *    `!activeSessionId` early return) and calls `flushRef.current()` on the
 *    falling edge of `composerLocked`;
 *  - part 2 is the assignment below, which now runs in the HOOK BODY — the same
 *    render-phase ref mirror `ChatStream` uses for `attachmentsRef`,
 *    `activeSessionIdRef` and `draftRef`.
 *
 * THE ONE double-send **Set** is an ARGUMENT, the SAME instance
 * `useChatPromptDispatch` receives — `send` and `flushHead` both check-and-add
 * against it, and two `Set`s would defeat the guard (a manual send in flight
 * would not be visible to the **Flush**). `ChatStream` declares it; this hook
 * never calls `useRef` for it.
 *
 * `sendText` is an ARGUMENT rather than something this hook reaches for, and the
 * reason is the ordering the moved code depended on: `flushHead` was declared
 * AFTER `sendText` so it closed over it. Passing the dispatch hook's result in
 * preserves that "the send tail already exists" order by construction, and it is
 * what keeps a queued **Mention** expanding byte-identically to a typed one.
 *
 * PLACEMENT NOTE (documented, deliberately NOT "fixed"): the `flushRef.current`
 * assignment used to run only on the full-frame path (below `ChatStream`'s
 * `!activeSessionId` early return); inside the hook it runs on EVERY render,
 * including the no-session frame. That is observationally identical: on the
 * no-session frame `composerLocked` is always false (no `inTurn`, no `agentState`,
 * no `compacting`) so the edge never fires, `useSessionIdleEdge`'s `key` is the
 * stable `""`, and the moment a session appears the key change RE-SEEDS the edge
 * — and `flushHead` short-circuits on `!sessionId` anyway. No test distinguishes
 * the two placements; the "renders with no active session without crashing, and
 * still flushes once one appears" test covers both directions.
 */

export interface UsePromptQueueFlusherArgs {
  /** The trigger's far end: `ChatStream`'s `useSessionIdleEdge` calls
   * `flushRef.current()`, and this hook takes the ref over during render. */
  flushRef: RefObject<() => void>;
  /** Passed in from `useChatPromptDispatch`'s result — preserves "flushHead is
   * declared AFTER `sendText` so it closes over it". */
  sendText: UseChatPromptDispatchResult["sendText"];
  /** The SAME **Set** the dispatch hook holds (see the header). */
  sendingSessionsRef: RefObject<Set<string>>;
  activeSessionIdRef: RefObject<string | null>;
  imageCapable: boolean;
  setError: (value: string | null) => void;
}

export function usePromptQueueFlusher(args: UsePromptQueueFlusherArgs): void {
  const {
    flushRef,
    sendText,
    sendingSessionsRef,
    activeSessionIdRef,
    imageCapable,
    setError,
  } = args;
  const turnCompleted = useSessions((s) => s.turnCompleted);
  // ── The **Flush** (ADR 0069) ───────────────────────────────────────────────
  // Sends the queue's head as an ordinary prompt. Declared AFTER `sendText` (an
  // ARGUMENT, so it exists before this line) so it closes over it — and a plain
  // `const`, NOT a hook or a `useCallback`: this is a fresh closure every render,
  // which is exactly what makes the values it reads (`imageCapable`, the store
  // actions, `sendText`) current. It is reached only through `flushRef`, which
  // the idle edge calls.

  const flushHead = async () => {
    // VISIBLE **Session** only, and that is a correctness rule rather than a
    // scope choice: `sendText` expands **Mentions** through catalogs keyed on
    // the ACTIVE **Session**'s Space (`spacePath`), so a background **Session**'s
    // prompt would expand against the WRONG **Space**.
    const sessionId = activeSessionIdRef.current;
    // `sendingSessionsRef` is the same double-send slot `send()` uses: a manual
    // send already in flight owns this session, and a **Flush** must not race it
    // into a second `send_prompt` (the harness's `pending_turn` claim is atomic
    // and refuses the loser).
    if (!sessionId || sendingSessionsRef.current.has(sessionId)) return;
    const entry = useQueuedPrompts.getState().takeHead(sessionId);
    // `undefined` covers an empty queue AND a queue whose every live entry is
    // `failed` or under edit — `takeHead` skips those rather than blocking the
    // entries behind them, so an all-skipped list simply has nothing to send.
    if (!entry) return;
    sendingSessionsRef.current.add(sessionId);
    // Did this Flush reach the send tail at all? `sendText` is the only thing
    // here that calls `beginTurn`, so the flag is set immediately before that ONE
    // call — the last point before a turn can be opened. The catch needs it
    // because it is SHARED by two very different failures: a rejection from
    // `sendText` left a live turn that must be settled, while a `FileReader`
    // failure during the attachment read happened BEFORE any turn was opened —
    // settling that one would overwrite the previous turn's stop reason and hide
    // the footer's "Turn ended: …" line, for a prompt that never went anywhere.
    // `send()` handles the same asymmetry by `return`ing from its read arm
    // before its catch can see it; this body has one `try`, so the flag carries
    // the distinction instead.
    let dispatched = false;
    try {
      // Fail-closed on capability exactly as `send()` does. `imageCapable` is
      // the render-derived value and `flushHead` is a fresh closure every
      // render, so it is current — `send()`'s post-resume re-derivation exists
      // only because a resume can happen MID-send, and the Flush never resumes
      // anything (a **Queue** entry only ever exists on a session you could
      // already send to).
      const images: SendTextImages | undefined =
        entry.attachments.length > 0 && imageCapable
          ? await Promise.all(
              entry.attachments.map(async (att) => ({
                id: att.id,
                name: att.filename,
                mimeType: att.mimeType,
                sizeBytes: att.sizeBytes,
                data: await readAttachmentAsBase64(att),
              })),
            )
          : undefined;
      // The Flush has NO composer, so `onCommitted` — the hook where `send()`
      // wipes the draft and moves the held thumbnails out of the strip — is an
      // empty function: the entry's text and attachments already left the
      // composer when it was queued. It stays a REQUIRED argument (making it
      // optional would add a branch to `sendText` for a caller that has nothing
      // to commit).
      //
      // Set IMMEDIATELY before the call: everything above this line can fail
      // without a turn having been opened, everything below it failed after one
      // was. See the flag's comment.
      dispatched = true;
      const stopReason = await sendText(sessionId, entry.text, images, () => {});
      // UNREACHABLE from this caller and deliberately UNTESTED: `sendText` only
      // returns `null` from its images-empty-with-no-text arm, which needs
      // `images === []`, and this caller passes `undefined` or a NON-EMPTY array.
      // Keep it — it is what makes the `StopReason | null` union exhaustive for
      // `turnCompleted` below — but read it as a type branch, not as covered
      // behaviour.
      if (stopReason === null) return;
      // The dispatch path owns these URLs: Task 1's `forget` refuses to release
      // a "sent" entry precisely because the sender does. Nothing after this
      // point can put them back in a row.
      //
      // AFTER the `null` guard, which is where the OWNERSHIP rule reads the way
      // it actually holds: these URLs are released when a send HAPPENED, not
      // merely when `sendText` came back. `null` means nothing was dispatched, so
      // on that arm the entry's previews would have been revoked while its row
      // was requeued by the failure paths — reachable only if a caller ever
      // passes `images === []`, which this one does not (see the guard above), but
      // the order must not state the rule backwards.
      entry.attachments.forEach(releaseAttachment);
      turnCompleted(sessionId, stopReason);
    } catch (err) {
      // ONLY settle a turn that was opened. A `sendText` rejection came after
      // `beginTurn`, so the bookkeeping has to be closed here exactly as
      // `send()`'s `catch` does; a `FileReader` failure came BEFORE it, and
      // settling THAT would overwrite the previous turn's stop reason and erase
      // the footer's "Turn ended: …" line for a prompt that never shipped. See
      // the `dispatched` flag's comment for why one shared catch needs the flag.
      // Settle FIRST, then requeue: both are synchronous and the hook's edge
      // cannot run until React re-renders, so `takeHead` sees the entry already
      // marked `failed` — but the ordering is what makes that reasoning
      // one-line obvious at the point where the self-inflicted edge is produced.
      if (dispatched) turnCompleted(sessionId, "end_turn");
      // Restore the head AND mark it failed. `leaving` clears so its row stops
      // animating out, its object URLs were never revoked so the preview is
      // still valid, and `failed` is what stops the idle edge `turnCompleted`
      // just caused from re-sending it (and on the undispatched arm there was no
      // edge at all — the entry stays put either way, which is the point: the
      // prompt must remain VISIBLE whatever failed).
      //
      // WHY A MARKER AND NOT A "FLUSH IN PROGRESS" REF: that edge fires AFTER
      // this function's `finally` has cleared any such ref, so the guard would
      // already have lapsed by the time the hook read it — the retry loop would
      // survive the fix. `failed` is durable state instead of a timing window,
      // and it buys the right user behaviour for free: the prompt stays visibly
      // queued and becomes sendable again only when the user saves an edit of it
      // (`updateText` clears the flag). One consequence worth knowing: the edge
      // a failure causes moves on to the NEXT non-failed entry, so one broken
      // prompt never stalls the ones queued behind it.
      useQueuedPrompts.getState().requeueHead(sessionId, { ...entry, leaving: undefined, failed: true });
      if (activeSessionIdRef.current === sessionId) setError(describeIpcError(err));
    } finally {
      sendingSessionsRef.current.delete(sessionId);
    }
  };

  // Part 2 of the trigger: a plain assignment (NOT a hook — the hook already ran
  // in the caller's unconditional block above its early return), the same
  // render-phase ref mirror the caller uses for `attachmentsRef`,
  // `activeSessionIdRef` and `draftRef`. A discarded concurrent render can leave
  // ITS closure in the ref and the next render re-assigns it — harmless here
  // (`flushHead` re-reads every value from the stores and the refs when it runs)
  // and worth saying, because it is the one thing a reader of a render-phase
  // write worries about.
  flushRef.current = () => {
    void flushHead();
  };
}
