import { useState } from "react";
import type { RefObject } from "react";
import { sendPrompt, compactSession, type StopReason } from "../lib/tauri";
import { describeIpcError } from "../lib/ipcError";
import { parseComposerCommand } from "../lib/composerCommands";
import { expandMentions } from "../lib/skills";
import {
  agentSupportsImages,
  draftIsMarkerOnly,
  readAttachmentAsBase64,
  type ChatComposerAttachment,
  type ImageRef,
} from "../lib/chatAttachments";
import { useSessions } from "../store/sessions";
import { useQueuedPrompts } from "../store/queuedPrompts";
import type {
  AgentDefinitionDto,
  McpServerInfo,
  SkillInfo,
} from "../lib/tauri";

/**
 * The composer's **Prompt dispatch** (issue #135 §2): `sendText` (the shared send
 * tail), `send` (the typed-prompt dispatch — the ADR 0069 queue fork, the ADR 0044
 * `/compact` interception and the double-send guard) and `resume` — all MOVED
 * VERBATIM out of `ChatStream.tsx`, comments and load-bearing order included.
 * Nothing here is improved: the order inside `send` IS the feature (the locked
 * fork sits BEFORE the double-send claim and before the `try`; the `/compact`
 * consumption sits INSIDE the `try` and BEFORE the auto-resume), and every
 * placement comment that records why moved with its code.
 *
 * WHAT THE HOOK OWNS: one state cell, `resuming` — `resume`'s own re-entrancy
 * flag, whose only readers are inside `resume` (verified: `resuming` appeared in
 * `ChatStream.tsx` solely as its declaration and inside `resume`, with no JSX
 * consumer). It owns NO draft, NO error line, NO attachment state: `send` writes
 * the draft through the caller's `setDraft`, lands errors through the caller's
 * `setError`, and reaches the attachment lifecycle through the
 * `useChatAttachments` boundary functions it RECEIVES (`clearStaged`,
 * `moveOutForSend`, `restoreHeldForSend`, `releaseHeldForSend`) — `useMentionPicker`'s
 * "the hook never owns the draft" is the precedent, and wave 2 already moved the
 * held-for-send map into that hook.
 *
 * THE ONE double-send **Set**: `sendingSessionsRef` is an ARGUMENT, created by
 * `ChatStream` and handed to this hook AND to `usePromptQueueFlusher`. A second
 * `Set` anywhere would defeat the guard — a manual send in flight would not be
 * visible to the **Flush**'s check-and-add — so neither hook may create one. The
 * failure mode of getting this wrong is a session stranded in the **Set**: "the
 * composer would look alive and never fire".
 *
 * EQUIVALENCE SUBSTITUTIONS (the ONLY textual changes to the moved bodies; each
 * is observationally identical because every entry point runs from an event
 * handler — i.e. AFTER the render-phase ref re-syncs `draftRef.current = draft`
 * and `activeSessionIdRef.current = activeSessionId`, so at call time the ref
 * holds exactly what the matching render's closure held):
 *  1. `send`'s `const targetSessionId = activeSessionId;` → the live ref read.
 *     The post-await switch is still guarded by the SEPARATE
 *     `activeSessionIdRef.current !== targetSessionId` check (unchanged).
 *  2. `send`'s `const rawText = draft.trim();` → the live `draftRef` read. The
 *     stale-draft guard that later compares `draftRef.current.trim() !== rawText`
 *     is unchanged — it still reads the LIVE ref after the awaits.
 *  3. `hasImages`'s initial value is the ARG (the component's const); the
 *     resume-arm re-derivation rebinds this hook's LOCAL `let`, reading
 *     `attachments.length` from the ARG snapshot — identical to the closure read,
 *     including the pre-window "drop during the resume await is not seen" semantics.
 *  4. `resume`'s `if (!activeSessionId || resuming)` → the live ref read (same
 *     reasoning as 1; `resume` is only ever called from `send`).
 *  5. The RENDER-SNAPSHOT reads inside `send` (`attachments.length` at the
 *     re-derive, `attachments.map` in the FileReader block) use the `attachments`
 *     ARG; the LIVE reads (`attachmentsRef.current` at the fork's `const moved`,
 *     and at the `liveIds` reconcile) use the `attachmentsRef` arg. The two are
 *     deliberately NOT collapsed — the original read the ref for the move and the
 *     reconcile, and the snapshot for the payload build.
 */

/** The reconciled attachment payload `sendText` takes (id-bearing, unlike the
 * `ImageRef` that goes on the wire). Exported because Task 5's Flush builds one. */
export type SendTextImages = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  data: string;
}[];

export interface UseChatPromptDispatchArgs {
  // Component setters — the hook owns NEITHER cell (the same split as
  // `useChatAttachments`: "the hook owns none of them").
  setDraft: (value: string) => void;
  setError: (value: string | null) => void;
  // Live refs — handled in, exactly as `send` reads them today.
  draftRef: RefObject<string>;
  activeSessionIdRef: RefObject<string | null>;
  /** THE ONE double-send **Set** — created by `ChatStream`, handed to BOTH hooks.
   * Never create a second one anywhere (see the header). */
  sendingSessionsRef: RefObject<Set<string>>;
  // Render values, captured per render exactly as `send`'s closure captured them.
  composerLocked: boolean;
  isLive: boolean;
  canResume: boolean;
  /** The component's `hasImages` derivation (the render's value; the resume arm
   * re-derives a LOCAL copy inside `send`). */
  hasImages: boolean;
  /** The RENDER-SNAPSHOT staged list (payload build), distinct from the LIVE
   * `attachmentsRef` reads (the move + the reconcile) — see substitution 5. */
  attachments: ChatComposerAttachment[];
  attachmentsRef: RefObject<ChatComposerAttachment[]>;
  // The Mention catalogs + the `#` gate — `sendText` expands against THESE (the
  // catalog of THAT moment; ADR 0069 stores the RAW draft for exactly this).
  skills: SkillInfo[];
  agents: AgentDefinitionDto[];
  mcpServers: McpServerInfo[];
  mcpMentionsEnabled: boolean;
  // The `useChatAttachments` boundary — RECEIVED, never re-owned.
  moveOutForSend: (targetSessionId: string, sentIds: Set<string>) => void;
  restoreHeldForSend: (
    targetSessionId: string,
    errorMsg: string,
    setError: (value: string | null) => void,
    setDraft: (value: string) => void,
  ) => void;
  releaseHeldForSend: (targetSessionId: string) => void;
  clearStaged: () => void;
}

export interface UseChatPromptDispatchResult {
  sendText: (
    sessionId: string,
    rawText: string,
    images: SendTextImages | undefined,
    onCommitted: (sentIds: Set<string>) => void,
  ) => Promise<StopReason | null>;
  send: () => Promise<void>;
}

/**
 * `resume` is deliberately NOT part of the result: it moved in as a private
 * closure used by `send`'s `!isLive` arm. `ChatStream` never destructures a
 * `resume` handle, and `noUnusedLocals` would reject the binding — the wave-2
 * precedent is `stageFiles`, returned by `useChatAttachments` but not
 * destructured because its consumers moved with it.
 */
export function useChatPromptDispatch(
  args: UseChatPromptDispatchArgs,
): UseChatPromptDispatchResult {
  const {
    setDraft,
    setError,
    draftRef,
    activeSessionIdRef,
    sendingSessionsRef,
    composerLocked,
    isLive,
    canResume,
    hasImages: hasImagesArg,
    attachments,
    attachmentsRef,
    skills,
    agents,
    mcpServers,
    mcpMentionsEnabled,
    moveOutForSend,
    restoreHeldForSend,
    releaseHeldForSend,
    clearStaged,
  } = args;
  // The re-entrancy flag for `resume` — the ONE cell this hook owns (see header).
  const [resuming, setResuming] = useState(false);
  const addUserMessage = useSessions((s) => s.addUserMessage);
  // A Client-authored transcript line — the `/compact` no-op's only feedback
  // (ADR 0044). Pulled the same way every other store action is pulled here.
  const addSystemLine = useSessions((s) => s.addSystemLine);
  const beginTurn = useSessions((s) => s.beginTurn);
  const turnCompleted = useSessions((s) => s.turnCompleted);
  const resumeSession = useSessions((s) => s.resumeSession);
  // `hasImages`: a staged attachment AND the capability — the last line of the
  // fail-closed defense. The component derives the render's value (its comment
  // block travels with the derivation); `let` because the resume arm below
  // RE-DERIVES it — the FRESH agent's capabilities (not the saved ones) decide
  // whether images ship.
  let hasImages = hasImagesArg;

  /** The shared send tail: expand → normalise → the user row → beginTurn →
   * sendPrompt. `rawText` is the RAW draft and `images` is the CALLER's already
   * reconciled attachment list (id-bearing); the caller owns composer STATE, so
   * this never calls `setDraft` / `setAttachments` and never calls `turnCompleted`.
   *
   * `onCommitted(sentIds)` fires immediately BEFORE `addUserMessage` — that is
   * where `send()`'s `setDraft("")` and its held-attachment move sit today, and
   * `sentIds` is what the move filters on.
   *
   * Resolves `null` for "NOTHING was dispatched — bail silently, do NOT settle":
   * it can only come from the every-attachment-removed-with-no-text arm below,
   * which runs BEFORE `addUserMessage`, so on that path no user row exists,
   * `onCommitted` never fired, `beginTurn` never ran and there is no turn to
   * settle. `null` therefore means the caller's draft was NEVER wiped — which is
   * exactly what today's `return` at `:1074` guarantees, and the reason the draft
   * wipe had to move inside this function. */
  const sendText = async (
    sessionId: string,
    rawText: string,
    images: SendTextImages | undefined,
    onCommitted: (sentIds: Set<string>) => void,
  ): Promise<StopReason | null> => {
    // EXPANSION: expand `$` / `@` / `#` mentions into their block forms
    // BEFORE both `addUserMessage` and `sendPrompt` (the REFINEMENT — the
    // live bubble, the persisted record, and the agent's input must all
    // carry the SAME text, so the content-based dedupe key in
    // `mergeDedupeKey` matches across a resume reload). Declared HERE
    // (immediately after the caller's stale-draft guard, BEFORE the images-empty
    // block below which still references `text`) — the placement is
    // load-bearing (a TDZ trap: a later declaration would make the
    // unchanged `if (!text)` a "used before its declaration" error;
    // semantically it's safe — expansion maps `""`→`""`, so `!text` is
    // identical to `!rawText`).
    // The `#` gate (see the `mcpMentionsEnabled` note above): an EMPTY MCP
    // catalog means a `#` token matches nothing, so the text stays
    // BYTE-IDENTICAL — the existing verbatim path, not a special case.
    //
    // THE MASK, and why it is not cosmetic: `[image #3]` IS a `#` mention
    // token — `MCP_MENTION_RE` is `/(^|\s)#([a-z0-9]+(?:-[a-z0-9]+)*)/g`, the
    // `#` has its leading space and a digit is in the class. It survives today
    // only because no catalog entry happens to be named `3`, and that is not a
    // guarantee: the Rust picker predicate `is_mentionable_name` accepts
    // digits (its own tests use `"0"` as a positive case), so an MCP server
    // literally named `3` would get an `<mcp name="3">` block appended to a
    // prompt the user never asked for. So the markers are lifted out BEFORE
    // the expansion and put back byte-exact AFTER it: `expandMentions` sees no
    // `#` token from a marker at all, and the marker text is stashed rather
    // than re-derived, so the round trip is exact.
    //
    // THE SENTINEL IS PASTABLE, and that is what the collision guard below is
    // for. `\uE000` is a Private Use Area codepoint: no keyboard produces it —
    // TRUE — but a PASTE carries arbitrary codepoints, and pasted logs, data
    // dumps and mojibake are exactly where PUA characters live. So the mask is
    // NOT structurally un-obtainable and the round trip is not automatically a
    // bijection: a draft can arrive at the un-mask holding a sentinel that no
    // marker put there. What makes the design safe is the guard, not the
    // choice of codepoint.
    const marks: string[] = [];
    const masked = rawText.replace(/\[image #(\d+)\]/g, (marker) => {
      marks.push(marker);
      return "\uE000";
    });
    // A PASTED sentinel sitting in a draft that also has a marker: the un-mask
    // cannot tell the user's stray byte from one of our placeholders, so the
    // round trip could hand a marker's text to the wrong position. Such a
    // draft is pathological (nothing the composer produces writes a PUA
    // character), and the two ways out are not equal: sending the user's own
    // text UNEXPANDED costs one send its `<mcp>` / `<skill>` blocks, while
    // continuing would CORRUPT the prompt the model reads. Degrading is the
    // safe side, so that is what this does.
    //
    // A sentinel in a draft with NO marker needs no guard: nothing was masked,
    // so nothing can be mis-restored — the bounded replacer below just lets the
    // user's byte pass through, and expansion runs normally.
    let text: string;
    if (marks.length > 0 && rawText.includes("\uE000")) {
      text = rawText;
    } else {
      const expanded = expandMentions(masked, {
        skills,
        agents,
        mcpServers: mcpMentionsEnabled ? mcpServers : [],
      });
      let markIndex = 0;
      // BOUNDED on purpose, and it is not defensive noise: an unbounded
      // `marks[markIndex++]` returns `undefined` once the stashes run out, and
      // `String.prototype.replace` STRINGIFIES what a replacer returns — so a
      // pasted sentinel would ship the literal word "undefined" to the model in
      // place of the user's character. Returning the sentinel itself keeps the
      // text byte-identical to what the user had.
      text = expanded.replace(
        /\uE000/g,
        () => (markIndex < marks.length ? marks[markIndex++] : "\uE000"),
      );
    }
    // Every staged image was removed during the read (the composer isn't
    // locked until `beginTurn`, so a thumbnail can be removed during the
    // read): with no text there's nothing meaningful left to send; with
    // text, normalize to `undefined` so the 2-arg `sendPrompt` path is taken
    // (an empty `[]` is truthy and would take the 3-arg path, sending an
    // empty images array).
    if (images !== undefined && images.length === 0) {
      // THE ONLY ROUTE TO `null` — and it is narrower than it looks. Simply
      // removing a thumbnail during the read does NOT reach it: `removeAttachment`
      // renumbers the draft, which drops the `[image #N]` marker text, so the
      // CALLER's stale-draft guard (`draftRef.current.trim() !== rawText`)
      // aborts first — `ChatStream.test.tsx:2368-2377` documents exactly that
      // (its own comment: "the STALE-DRAFT GUARD ... fires before the
      // images-empty block below, which no longer sees an empty text to
      // reject"). To land here a send must arrive with the reconcile yielding
      // `images === []` AND `text === ""`: stage attachments, delete the
      // `[image #N]` marker text BY HAND so the draft is already empty when the
      // read lands (the stale-draft guard then passes, because empty == empty),
      // and remove every thumbnail during the `FileReader` await.
      //
      // Returning `null` here — and NOT calling `onCommitted` first — is what
      // keeps the user's draft intact: nothing was dispatched, no user row
      // exists, `beginTurn` never ran, so there is no turn to settle and the
      // composer must not be wiped.
      if (!text) return null;
      images = undefined;
    }
    // `sentIds` is derived from what was ACTUALLY sent (the reconciled
    // `images`), not the stale closure list: on success, release/clear ONLY
    // these. Anything staged after the read — e.g. a drop during the
    // FileReader `await`, or attachments staged in ANOTHER session while
    // this turn was running — must survive.
    const sentIds = new Set(images?.map((i) => i.id) ?? []);
    // `ImageRef` has no `id` field — built field-by-field rather than by
    // discarding `id` in a destructure, because `noUnusedLocals` is ON and an
    // underscore does NOT exempt a destructured binding from being "unused".
    const imageRefs: ImageRef[] | undefined = images?.map((i) => ({
      name: i.name,
      mimeType: i.mimeType,
      sizeBytes: i.sizeBytes,
      data: i.data,
    }));
    onCommitted(sentIds);
    addUserMessage(sessionId, text, imageRefs); // EXPANDED
    beginTurn(sessionId);
    // Pass the third arg ONLY when there are images: a text-only send (and
    // an all-images-removed send, normalized above) calls
    // `sendPrompt(id, text)` — the pre-existing 2-arg call the existing tests
    // assert (`toHaveBeenCalledWith("s1", "hello")`; vitest compares arg
    // arrays by length, so an explicit `undefined` third arg would break it).
    const stopReason = imageRefs
      ? await sendPrompt(sessionId, text, imageRefs) // EXPANDED
      : await sendPrompt(sessionId, text); // EXPANDED
    // NOTE: no `turnCompleted` here. The success path releases `heldForSendRef`
    // BEFORE settling and the `catch` settles BEFORE `setError` + the
    // attachment restore (one React 19 batch), so moving the settle in here
    // would invert both orders — each caller owns its own settle.
    return stopReason;
  };
  const send = async () => {
    // EQUIVALENCE SUBSTITUTION (header, note 1): the original read
    // `activeSessionId`; the live ref holds the SAME value the render that
    // produced this click saw, because `send` only runs from an event handler —
    // after the render-phase re-sync. The post-await switch guard below is the
    // SEPARATE `activeSessionIdRef.current !== targetSessionId` check, unchanged.
    const targetSessionId = activeSessionIdRef.current;
    if (!targetSessionId) return;
    // EQUIVALENCE SUBSTITUTION (header, note 2): `draft.trim()` → the live ref
    // (the stale-draft guard further down still reads the LIVE ref, unchanged).
    const rawText = (draftRef.current ?? "").trim();
    // A marker is draft TEXT, so "the user pasted a screenshot and typed
    // nothing" is no longer `rawText === ""` — it reads `[image #1]`. Without
    // `draftIsMarkerOnly`, an image-only send on a session whose capability has
    // regressed would ship the SENTENCE "here is [image #1]" to an agent that
    // receives no image at all, which is worse than the empty prompt this guard
    // exists to block. Real prose is unaffected (still sent text-only).
    //
    // SPLIT (ADR 0069): the emptiness check and the LOCK check are no longer one
    // condition. Empty stays a silent no-op — there is nothing to queue — but a
    // non-empty draft while the composer is locked now has somewhere to go: the
    // **Prompt queue**. The lock itself is unchanged (`composerLocked`, and
    // `ComposerRow`'s `disabled` props): the harness is still one-turn-at-a-time
    // and a queued prompt is NEVER dispatched here — the **Flush** sends it later
    // as an ordinary `send_prompt`.
    if (!hasImages && (rawText === "" || draftIsMarkerOnly(rawText))) return;
    // ── The fork. It sits BEFORE `sendingSessionsRef` and before the `try`, so a
    // queueing press never occupies the double-send slot (and, because it returns
    // ahead of the `try`, it must not rely on the `finally` for cleanup — and it
    // needs none: `setDraft` and the hook's non-revoking `clearStaged()` are its
    // only effects).
    if (composerLocked) {
      // A **Composer command** is NEVER queued, and the two contracts are why:
      // ADR 0044's defining act is that `/compact` is CONSUMED (nothing sent, no
      // user row), while a queue entry's whole contract is "becomes an ordinary
      // `send_prompt`". Queuing it would deliver the literal text `/compact` to
      // the model. It gets a VISIBLE line instead of today's dead key — and the
      // draft is left alone, so the same Enter works once the turn ends.
      const command = parseComposerCommand(rawText);
      if (command) {
        addSystemLine(
          targetSessionId,
          `/${command.name} runs when this turn ends — try again then.`,
        );
        return;
      }
      // The URLs MOVE with the text: never revoke here, or the queue row's
      // preview and the later send both lose the file. The `[image #N]` markers
      // travel UNTOUCHED for the same reason-in-reverse: the numbering is
      // per-message, message-ness is preserved by the move, so there is nothing
      // to renumber. Nor is the text expanded — ADR 0069 stores the RAW draft so
      // expansion runs at send, against the catalog of THAT moment.
      const moved = attachmentsRef.current;
      clearStaged(); // ref + state emptied; the URLs MOVE with the text (no revoke)
      useQueuedPrompts.getState().enqueue(targetSessionId, {
        id: crypto.randomUUID(),
        text: rawText,
        attachments: moved,
        state: "queued",
      });
      setDraft("");
      return;
    }
    if (sendingSessionsRef.current.has(targetSessionId)) return; // guard: see the ref's comment above
    sendingSessionsRef.current.add(targetSessionId);
    try {
      setError(null);
      // ── A **Composer command** is consumed HERE and goes no further (ADR
      // 0044): no `addUserMessage`, no `beginTurn`, no `sendPrompt`, no
      // `turnCompleted`. ADR 0031's byte-identity contract is deliberately
      // narrower than "nothing in the draft is rewritten" — it governs text that
      // IS SENT, and this sends nothing.
      //
      // TWO PLACEMENT RULES, both load-bearing:
      //  • INSIDE the `try`, not before it. `send()` ends in a
      //    `finally { sendingSessionsRef.current.delete(targetSessionId) }`, so an early `return` above
      //    the `try` would leave the session stuck in the set and silently break EVERY
      //    later send — the composer would look alive and never fire.
      //  • BEFORE the `if (!isLive)` auto-resume block below. A command that
      //    fell through it would RESUME a stored session purely to compact it —
      //    the exact flow ADR 0044 rejects — and would then make
      //    `compact_session` report the session LIVE, so the non-live answer
      //    below could never happen. The order is the feature.
      // Because it also precedes the FileReader block, staged attachments are
      // left staged and unsent: a Composer command is not a prompt.
      const command = parseComposerCommand(rawText);
      if (command) {
        setDraft("");
        if (command.name === "compact") {
          // `args` are the user's extra summary instructions; an argument-less
          // `/compact` is `null`, NOT `""` (see `compactSession`). `false` is the
          // not-live answer, not an error, and this line is its only feedback —
          // a silent no-op would look like a dead button.
          const live = await compactSession(
            targetSessionId,
            command.args || null,
          );
          if (!live) {
            addSystemLine(
              targetSessionId,
              "Nothing to compact — this session is not open.",
            );
          }
        }
        return;
      }
      // Auto-resume a stored (non-live) session before sending. A non-resumable
      // stored session can't be sent to; a failed resume aborts (error already set).
      if (!isLive) {
        if (!canResume) return;
        if (!(await resume())) return;
        // The resume reconnected to a FRESH agent: the SAVED capabilities
        // that gated `hasImages` above are stale. Re-derive from the live
        // session's capabilities (the store's `resumeSession` just upserted
        // the resume result): if the fresh agent doesn't advertise
        // `promptCapabilities.image`, proceed text-only (the same
        // fail-closed treatment — an image-ONLY send is blocked, a text
        // send simply doesn't attach the staged images); if it DOES
        // advertise images, include them.
        const fresh = useSessions
          .getState()
          .sessions.find((x) => x.sessionId === targetSessionId);
        hasImages =
          attachments.length > 0 && agentSupportsImages(fresh?.capabilities);
        // A marker is draft TEXT, so `rawText === ""` alone no longer describes
        // "the user attached a screenshot and typed nothing" — the draft now
        // reads `[image #1]`. Without this, a staged image plus a fresh agent
        // that cannot take images would send the sentence "look at [image #1]"
        // to a model that receives NO image, which is worse than the empty
        // prompt this guard exists to block. So "nothing but markers" counts as
        // no prose: the same fail-closed posture, unchanged for real text.
        if (!hasImages && (rawText === "" || draftIsMarkerOnly(rawText))) return;
      }
      let images: SendTextImages | undefined;
      if (hasImages) {
        try {
          const read = await Promise.all(
            attachments.map(async (att) => ({
              id: att.id,
              name: att.filename,
              mimeType: att.mimeType,
              sizeBytes: att.sizeBytes,
              data: await readAttachmentAsBase64(att),
            })),
          );
          // Reconcile against the LIVE list: the composer isn't locked until
          // beginTurn, so a thumbnail removed during the read must not be sent.
          const liveIds = new Set(attachmentsRef.current.map((a) => a.id));
          images = read.filter((i) => liveIds.has(i.id));
        } catch {
          if (activeSessionIdRef.current === targetSessionId) {
            setError("Failed to read an attached image");
          }
          return; // attachments stay staged; `sendingSessionsRef` resets in `finally`
        }
      }
      // Session switched during the read (the composer isn't locked until
      // beginTurn): the closure's `activeSessionId` is stale — abort without
      // sending, without wiping the draft, without completing a turn.
      if (activeSessionIdRef.current !== targetSessionId) return;
      // Draft edited during the read (the composer isn't locked until
      // `beginTurn`): sending the stale text and wiping the new draft is a
      // silent data loss — abort without sending, without wiping the draft,
      // without completing a turn (the user simply sends again). The guard
      // compares the RAW text (expansion is re-derived from the FRESH draft
      // below, so comparing expanded texts would be wrong).
      if (draftRef.current.trim() !== rawText) return;
      // The send tail — expansion, the images-empty normalisation, the user
      // row, `beginTurn`, `sendPrompt` — now lives in `sendText` so the prompt
      // queue's Flush runs the SAME code a typed prompt does (a queued Mention
      // must never expand differently from a typed one). `images` is passed
      // RECONCILED (the `liveIds` filter above already ran) because `sendText`
      // derives `sentIds` from what is actually going on the wire.
      //
      // `onCommitted` is where `setDraft("")` and the held-attachment move used
      // to sit, merged into ONE callback: today the held block ran three
      // statements after `setDraft("")` with **no `await` between them**, and
      // both are synchronous ref/state writes that React 19 batches into the
      // same commit — so firing them together at `setDraft`'s old position is
      // observationally identical, not a reordering a user or a test can see.
      const stopReason = await sendText(
        targetSessionId,
        rawText,
        images,
        (sentIds) => {
          setDraft("");
          // The staged `File`/object-URL pair has NO remaining job once the
          // base64 copies are on the user message: hold exactly the sent
          // attachments OUT of `attachments` so their thumbnails leave the
          // composer NOW instead of sitting there for the whole turn. They are
          // held, not released — the `catch` below puts them back on a failed
          // send, and the success path releases them when the turn settles.
          // `activeSessionIdRef` guard: a send whose session was switched away
          // during the read never touches the (now other session's) composer state.
          if (sentIds.size > 0 && activeSessionIdRef.current === targetSessionId) {
            moveOutForSend(targetSessionId, sentIds);
          }
        },
      );
      // NOTHING was dispatched (every attachment removed with no text): bail
      // silently, do NOT settle — no user row exists and `beginTurn` never ran.
      // This `return` sits AFTER the `sendText` await and so still runs the
      // `finally` below, releasing the double-send slot — exactly what today's
      // in-line `return` did.
      if (stopReason === null) return;
      // Success: the turn settled, so the held attachments have no job left —
      // release them for good and drop the map entry. Released from the HELD
      // list (they left `attachments` at send), NOT by re-filtering the staged
      // list by `sentIds`. The state is untouched here: the composer is
      // already clean, so only the `activeSessionIdRef`-guarded map entry has
      // to go (the held objects are released either way — a revoked URL is not
      // session-scoped).
      releaseHeldForSend(targetSessionId);
      turnCompleted(targetSessionId, stopReason);
    } catch (err) {
      turnCompleted(targetSessionId, "end_turn");
      // Tauri IPC rejections are strings OR plain objects (`{kind, message}`) —
      // `src/lib/ipcError.ts` is the one renderer for both shapes.
      const msg = describeIpcError(err);
      // The failed-send attachment restore — the whole block (the held list
      // merged back IN FRONT of whatever was staged during the turn, the
      // `MAX_CHAT_ATTACHMENTS` ceiling with the overflow released, the draft's
      // marker shift by the number ACTUALLY restored, the map delete, and the
      // error line) lives in `useChatAttachments.restoreHeldForSend`, whose
      // comment block records the contract. It is ONE synchronous call, so the
      // restore and the error line land in the same React 19 batch exactly as
      // when the block was inline (the pinned reason the error-line test is not
      // flaky), and the hook re-checks
      // `activeSessionIdRef.current === targetSessionId` for BOTH the restore
      // and the error line while ALWAYS running the map delete — so a session
      // switched away mid-send still restores nothing and shows no error, and
      // the delete stays a no-op once the session-switch effect released the
      // entry. `turnCompleted` above still settles the turn FIRST: each caller
      // owns its own settle.
      restoreHeldForSend(targetSessionId, msg, setError, setDraft);
    } finally {
      sendingSessionsRef.current.delete(targetSessionId);
    }
  };

  const resume = async (): Promise<boolean> => {
    // EQUIVALENCE SUBSTITUTION (header, note 4): `!activeSessionId` → the live
    // ref (same reasoning as note 1 — `resume` is only ever called from `send`,
    // which runs from an event handler after the render-phase re-sync).
    if (!activeSessionIdRef.current || resuming) return false;
    setResuming(true);
    setError(null);
    try {
      await resumeSession(activeSessionIdRef.current);
    } catch (err) {
      setError(describeIpcError(err));
      return false;
    } finally {
      setResuming(false);
    }
    return true;
  };

  return { sendText, send };
}
