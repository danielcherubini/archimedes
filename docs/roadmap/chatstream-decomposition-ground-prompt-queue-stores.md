---
status: grounding-report
area: prompt-dispatch / queue-flush / turn-lifecycle layer behind src/components/ChatStream.tsx (the stores and libs used by sendText, send, flushHead, resume)
issue: 135 (chatstream decomposition — (c) prompt dispatch + queue flush + resume)
repo: /home/daniel/Coding/AI/archimedes-desktop
branch: feature/chatstream-decomposition
base commit: b0071544
---

# Grounding report — prompt dispatch / queue flush / turn lifecycle (the layer `useChatPromptDispatch` + `usePromptQueueFlusher` will sit on)

Everything below is quoted **verbatim** from the named files at base commit
`b0071544` unless a quote is explicitly marked as paraphrase. Where a claim must
survive a commit, **symbols, never line numbers**, are named.

---

## 1. `src/store/queuedPrompts.ts` — the full API (ADR 0069)

### 1.1 The store (module singleton, zustand `create`)

The interface, verbatim:

```ts
interface QueuedPromptsState {
  /** Ordered per Session: the first LIVE entry is the next one to **Flush**. */
  bySession: Record<string, QueuedPrompt[]>;
  enqueue: (sessionId: string, prompt: QueuedPrompt) => void;
  /** Puts an entry back at the FRONT (a failed **Flush**), with `leaving` cleared. */
  requeueHead: (sessionId: string, prompt: QueuedPrompt) => void;
  updateText: (sessionId: string, id: string, text: string) => void;
  setEditing: (sessionId: string, id: string, editing: boolean) => void;
  removeAttachment: (sessionId: string, id: string, attachmentId: string) => void;
  takeHead: (sessionId: string) => QueuedPrompt | undefined;
  markLeaving: (sessionId: string, id: string, reason: "deleted") => void;
  forget: (sessionId: string, id: string) => void;
  clearSession: (sessionId: string) => void;
}
```

Exported names: `useQueuedPrompts` (the zustand hook/store — call sites use
`useQueuedPrompts.getState()`), the `QueuedPrompt` interface, `releaseAttachment`
and `ChatComposerAttachment` are imported from `../lib/chatAttachments`.

### 1.2 The queue-entry contract — a `QueuedPrompt` (verbatim)

```ts
export interface QueuedPrompt {
  /** `crypto.randomUUID()` at enqueue; the React key + the edit/delete handle. */
  id: string;
  /** The RAW draft — NEVER the Mention-expanded text (ADR 0069: expansion runs at send). */
  text: string;
  /** MOVED out of the composer, not copied — this entry owns their object URLs. */
  attachments: ChatComposerAttachment[];
  state: "queued" | "editing";
  /**
   * Set at exit; the row calls `forget` when its animation ends.
   * `undefined` = live (rendered, counted, and — unless `failed` or being
   * edited — a **Flush** candidate).
   */
  leaving?: "sent" | "deleted";
  /**
   * A **Flush** of this entry failed. Such an entry is LIVE (it renders and
   * counts) but is never a `takeHead` candidate — only saving an edit clears
   * it. This is what stops a failed send's own busy→idle edge from re-sending
   * it into the same failure.
   */
  failed?: boolean;
}
```

So an entry **does** carry: the RAW draft (`text`), the moved
`ChatComposerAttachment[]` (each with `{ id, file: File, filename, mimeType,
sizeBytes, objectUrl }` — verbatim from `src/lib/chatAttachments.ts`:
`ChatComposerAttachment` holds a real `File` and the composer's object URL), and
the `state` flag. It does **NOT** carry the expanded text, any `ImageRef`
base64 data, or any URLs/rows — expansion and base64 reads both run at send.

### 1.3 The module doc — "lives ONLY in the renderer" (verbatim)

```ts
/**
 * One entry of the **Prompt queue** (ADR 0069): a prompt the user sent while
 * its Session's turn was in flight. It lives ONLY in the renderer — the
 * Supervisor is never told a queue exists, so every queue operation (edit,
 * delete, **Flush**) is a plain list mutation here.
 */
```

And the deliberate absence of a live-filter (verbatim):

```ts
/**
 * NO `livePrompts`-style filter is exported, deliberately. The live-versus-
 * `leaving` rule is decided ONCE, inside `takeHead`, together with the `failed`
 * and `editing` skips — so there is exactly one place that answers "may this
 * entry send?", and no second filter to drift from it.
 *
 * The stack deliberately does NOT want a live-only view either: a row must stay
 * MOUNTED to play its exit, so `QueueRows` renders the raw list and gates on its
 * TOTAL length. An earlier `livePrompts` helper invited the stack to gate on it,
 * which strands every animating row — see the comment at that gate.
 */
```

### 1.4 Rules each action enforces (verbatim excerpts + signatures)

- `enqueue(sessionId, prompt)` — appends **to the END of the per-session array**
  (`[...(state.bySession[sessionId] ?? []), prompt]`); "the array order IS the
  send order".
- `requeueHead(sessionId, prompt)` — inserts the entry **at the FRONT** with
  `leaving: undefined` (dropping the stale copy, since `takeHead` marks rather
  than removes, so the same `id` is still in the list). **Guarded by the
  missing-key rule** (verbatim):

  ```ts
  // A CLOSED or DELETED Session has no key: `closeSession` / delete call
  // `clearSession` (ADR 0069 — a reopened Session must not offer a **Flush**
  // whose turn can never arrive), but a **Flush** already in flight doesn't
  // know that. Its `sendPrompt` then rejects with unknown-session and this
  // catch-path requeue runs: inserting unconditionally would re-create a key
  // nobody will ever clear again, orphaning an entry that holds a `File` and
  // previews that were already revoked. A MISSING key therefore means "this
  // Session's queue is gone" — drop the requeue.
  ```

- `takeHead(sessionId)` — the ONLY "may this entry send?" answer:
  `list.findIndex((p) => !p.leaving && !p.failed && p.state !== "editing")`; it
  **MARKS the taken entry `leaving: "sent"` rather than removing it** (the row
  must stay mounted for its exit). Doc (verbatim):

  ```ts
  /**
   * Marks the next entry to **Flush**, it does not remove it: the row has to
   * stay mounted to play its exit animation, and `leaving` is what makes it
   * invisible to the NEXT **Flush** at the same time.
   *
   * Synchronous on purpose — `get()` then `set()` with no `await` between, so
   * the read-and-mutate pair is atomic against a manual send racing it.
   *
   * Skips an entry that is not READY rather than blocking the ones behind it:
   * a `failed` entry would re-hit the same failure, and an entry under edit
   * holds the text from the LAST Save, so sending it would ship text the user
   * was in the middle of replacing (the hazard `send()`'s draftRef staleness
   * guard covers at `ChatStream.tsx:985-993`).
   */
  ```

  Note: it mentions `ChatStream.tsx:985-993` for the draft-staleness guard — that
  is a line-reference in the code itself and will drift; the guard is the
  `draftRef.current.trim() !== rawText` comparison in `send()`.
- `updateText(sessionId, id, text)` — **Saving an edited prompt IS the retry
  gesture, so the save clears `failed`** (`{ ...p, text, failed: undefined }`);
  it does NOT change `state` and does NOT touch `leaving`.
- `setEditing(sessionId, id, editing)` — flips `state` only; `failed` survives
  ("opening the editor is not a request to retry"); **is a NO-OP for an entry
  that is already `leaving`** (the ONE-ENTRY-ONE-EXIT-OWNER rule, shared with
  `markLeaving`).
- `removeAttachment(sessionId, id, attachmentId)` — reads the target OUT of the
  store and releases **BEFORE** `set(...)` ("never inside the updater, which
  React may run again").
- `markLeaving(sessionId, id, "deleted")` — the UI delete; also a NO-OP for an
  entry already `leaving` (verbatim): "REQUIRED, not defensive… the FIRST cause
  of the exit is the one that plays." (`"sent"` is written ONLY by `takeHead`;
  `markLeaving`'s only accepted reason is `"deleted"`.)
- `forget(sessionId, id)` — "The only remover — the row calls it when its exit
  animation ends." It releases attachments **ONLY when `leaving === "deleted"`**
  (verbatim): "for `leaving === "sent"` the dispatch path owns those URLs and
  releases them, so releasing here too would be a double-revoke under the send
  path's feet." It **deletes the `bySession` key rather than storing `[]`**
  when the list empties.
- `clearSession(sessionId)` — "Session closed / deleted (ADR 0069): the queue
  goes with it, so a reopened Session never offers a **Flush** whose turn can
  never arrive. Nobody owns the attachments any more, so this releases every one
  of them — for both `leaving` values." Called from BOTH
  `useSessions`' `deleteSession` and `lib/sessionLifecycle.ts`'s
  `onSessionClosed` (see §8.3).

### 1.5 Per-session keying

Single flat map `bySession: Record<string, QueuedPrompt[]>` keyed by the ACP
session id. There is an explicit "session isolation" test group (see §9.3).

---

## 2. `src/store/sessions.ts` — the turn lifecycle only

All signatures from `interface SessionsState` (verbatim); implementations
verbatim.

### 2.1 `beginTurn(sessionId: string): void`

```ts
  beginTurn: (sessionId) =>
    set((state) => ({ inTurn: { ...state.inTurn, [sessionId]: true } })),
```

Pre/post conditions: **sets `inTurn[sessionId] = true`**; idempotent (a second
call is a no-op write of the same value). It does NOT touch `stopReasons` and
does NOT touch `messages`. Comment contract in `ChatStream.tsx` (verbatim):
"`inTurn` is the ground truth for 'a turn is in flight' (set by `beginTurn`,
cleared by `turnCompleted`)".

### 2.2 `turnCompleted(sessionId: string, stopReason: StopReason): void`

```ts
  turnCompleted: (sessionId, stopReason) =>
    set((state) => ({
      inTurn: { ...state.inTurn, [sessionId]: false },
      stopReasons: { ...state.stopReasons, [sessionId]: stopReason },
    })),
```

Pre/post conditions: sets `inTurn[sessionId] = false` AND records
`stopReasons[sessionId] = stopReason` in the SAME `set` (one React commit —
the busy→idle edge the Flush triggers on fires exactly once). **Idempotent and
not guarded**: calling it for a session whose turn was never opened still writes
`stopReasons` — that is precisely why `flushHead`'s `dispatched` flag and
`sendText`'s `null` return exist (see §7 and §10). `stopReasons` is
**merge-only, keys never deleted** (`handleSessionClosed` does not clear it).
`StopReason` is `"end_turn" | "max_tokens" | "refusal" | "max_turn_requests" |
"cancelled"` (verbatim, `src/lib/tauri/types.ts`).

### 2.3 `addUserMessage(sessionId: string, text: string, images?: ImageRef[]): void`

```ts
  addUserMessage: (sessionId, text, images) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [sessionId]: [
          ...(state.messages[sessionId] ?? []),
          {
            kind: "user" as const,
            text,
            at: Date.now(),
            ...(images && images.length > 0 ? { images } : {}),
          },
        ],
      },
    })),
```

Guarantees: **appends** one `user` message with `at: Date.now()`; the `images`
key is **absent unless non-empty**. The caller passes the EXPANDED text
(`sendText` calls `addUserMessage(sessionId, text, imageRefs); // EXPANDED`).
`ImageRef` is `{ name, mimeType, sizeBytes, data }` (base64 WITHOUT a `data:`
prefix — `src/lib/chatAttachments.ts`), i.e. no `id` field — `sendText` builds
`imageRefs` field-by-field from its id-bearing `SendTextImages`.

### 2.4 `addSystemLine(sessionId: string, text: string): void`

Interface doc (verbatim, the ADR 0044 consumption contract):

```ts
  /**
   * Append ONE Client-authored line to the transcript, shaped exactly like an
   * agent-text message (so it renders in the stream with no new renderer).
   * Used by the `/compact` **Composer command** when there is nothing to
   * compact (ADR 0044): a command produces no user row and no model call, so
   * without this the no-op would be SILENT — the user would type something and
   * the app would do nothing at all.
   *
   * It DELEGATES to `applySessionUpdate` with an `agent_message_chunk` rather
   * than touching `messages` itself, and it MUST pass a UNIQUE `messageId` per
   * call: `case "agent_message_chunk"` APPENDS to the trailing agent-text when
   * that message carries the SAME id, with NO separator, so reusing the
   * harness's `"system"` key would weld two local lines (or a local line onto
   * a real harness system message) into one run-on bubble. Hence
   * `clientSystemMessageId()` below.
   */
```

Implementation:

```ts
  addSystemLine: (sessionId, text) =>
    get().applySessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
      messageId: clientSystemMessageId(),
    }),
```

The `messageId` comes from a module-local counter (`let clientMessageSeq = 0;
function clientSystemMessageId(): string { return `client:${++clientMessageSeq}`; }`)
— "A MODULE-LOCAL counter, not a timestamp: two lines appended in the same
millisecond must still differ". So the produced row has `kind: "agent-text"`
and a `client:<n>` id — NOT `kind: "system"` (pinned by
`ChatStream.test.tsx`'s "a Composer command while locked is NOT queued…" and by
`/compact`'s "a non-live answer (false) adds ONE system-style line with its own
messageId").

### 2.5 `resumeSession(sessionId: string): Promise<SessionInfo>`

Guarantees (verbatim): throws `new Error(`unknown session: ${sessionId}`)` when
the id is in NONE of the three lists (archived resumable). On success:
"the session becomes live" — `sessions` gains the row, `historySessions` loses
it, `archivedSessions` is deliberately NOT touched ("STICKY"),
`activeSessionId: st.activeSessionId ?? sessionId`, `stalled[id] = undefined`,
`configOptions` refreshed from `info.configOptions`. Then seeds the cost
accumulator (`seedCostFromRow`, only `if (info.costUsd != null)`) and fires a
**fire-and-forget** transcript reload `void (async () => { … loadHistory … })()`
that **merges** (`[...reloaded, ...fresh]`) rather than replaces, keyed by
identity `mergeDedupeKey` (ADR 0050). **The caller does NOT await the reload** —
a `send()` on the resumed session adds its user message while the reload is in
flight. `resumeSessionCommand(sessionId, session.cwd)` is the IPC (`src/lib/tauri
/commands/sessions.ts`, wrapper re-exported through the `src/lib/tauri` barrel).

### 2.6 `loadOlderHistory(sessionId: string): Promise<void>`

Guarantees (verbatim): refuses to start when the entry is missing / `!hasMore` /
`loadingMore` / `oldestRowId === null` ("so subsequent `loadOlderHistory` calls
refuse to start"); sets `loadingMore: true`, loads `OLDER_HISTORY_PAGE` (200)
rows `beforeId: oldestRowId`, and on arrival **bails unless
`current.generation === gen && current.epoch === ep`** ("Bail if session resumed
(generation or epoch bumped) or deleted in the interim"), else **PREPENDS** the
page (`[...prepended, ...currentMessages]`) and updates
`oldestRowId` / `hasMore` / `loadingMore` (keeping `gen` / `ep`). Both success
and catch arms clear `loadingMore`.

### 2.7 The state slices

- `inTurn: Record<string, boolean>` — "Whether a prompt turn is in flight for a
  session."
- `stopReasons: Record<string, StopReason>` — "Last stop reason reported for a
  session's turn." Merge-only.
- `history` (verbatim):

  ```ts
  /** History pagination window state per session id (ADR 0073). */
  history: Record<
    string,
    {
      oldestRowId: number | null;
      hasMore: boolean;
      loadingMore: boolean;
      generation: number;
      epoch: number;
    }
  >;
  ```

- `messages: Record<string, Message[]>` — "Transcript per session id. Kept after
  close for history." `Message` imported from `lib/sessionTypes`.

### 2.8 The ORDER of the extraction call — the live-bug contract

The exact sequence the dispatch path runs (names, and the order that is
load-bearing):

1. **Queue fork in `send()`** (locked): `parseComposerCommand(rawText)` →
   (command) `addSystemLine(...)` + return; (not a command) move attachments,
   `enqueue`, `setDraft("")`, return. **Before** `sendingSessionsRef` and
   before the `try` (a queueing press never occupies the double-send slot and
   never relies on the `finally`).
2. **Unlocked `send()`**: `sendingSessionsRef` add → `try` →
   `parseComposerCommand(rawText)` (command: `compactSession(...)` or the
   not-live `addSystemLine`, then return) → the `!isLive` auto-resume block
   (`await resume()`) → attachment base64 read → session-switch / stale-draft
   guards → **`sendText`** (which does: expansion → images-empty normalisation →
   `onCommitted(sentIds)` → `addUserMessage` → `beginTurn` → `sendPrompt` →
   returns `stopReason`) → success: release held attachments →
   `turnCompleted(targetSessionId, stopReason)`; catch: `turnCompleted(
   targetSessionId, "end_turn")` first, then error + restore; finally:
   `sendingSessionsRef.current.delete(targetSessionId)`.
3. **`flushHead()`**: guard `!sessionId || sendingSessionsRef.has(sessionId)` →
   `takeHead(sessionId)` → guard `!entry` → `sendingSessionsRef.add(sessionId)`
   → attachment base64 read (flag `dispatched = true` immediately before
   `sendText`) → `sendText(sessionId, entry.text, images, () => {})` →
   `null`-guard return → release entry attachments → `turnCompleted(sessionId,
   stopReason)`; catch: `if (dispatched) turnCompleted(sessionId, "end_turn")`,
   then `requeueHead(sessionId, { ...entry, leaving: undefined, failed: true })`
   + `setError(...)`; finally: delete from `sendingSessionsRef`.

What each guarantees about ordering/idempotency, precisely:

- **`beginTurn` runs AFTER every `await`** (comment verbatim): "`beginTurn` runs
  AFTER an `await` (the base64 read), so the composer is not locked until then
  and a second Enter/click during the read would otherwise double-send" — that
  is what `sendingSessionsRef` guards.
- **`turnCompleted` runs ONLY when a turn was opened**: success arms call it
  with the real `stopReason`; the shared catch settles `"end_turn"` FIRST
  ("Settle FIRST, then requeue: both are synchronous and the hook's edge cannot
  run until React re-renders, so `takeHead` sees the entry already marked
  `failed`").
- **`flushHead` must NOT settle a turn that was never opened** — the
  `dispatched` flag (verbatim): "the flag is set immediately before that ONE
  call — the last point before a turn can be opened."
- **`resume` awaits `resumeSession`**, and only then re-derives capabilities;
  `send()`'s stale-draft guard runs after the resume (a resume can take long
  enough to edit the draft).
- **`handleSessionClosed` clears `inTurn`** (`inTurn: { ...state.inTurn,
  [sessionId]: false }`), so a close is also a busy→idle transition — but the
  queue was already cleared by `onSessionClosed`/`deleteSession` (ADR 0069).

---

## 3. `src/store/interactive.ts` and `src/store/permissions.ts` — what `send` / `flushHead` read

### 3.1 `useInteractive` (zustand singleton, `src/store/interactive.ts`)

Reads used by the dispatch path:

- `agentState: Record<string, "working" | "idle" | "blocked">` — "The agent state
  machine (`working`/`idle`/`blocked`) — wired, not rendered in v1." Written
  ONLY by `applyState(sessionId, payload)` (validates the discriminant:
  `if (s !== "working" && s !== "idle" && s !== "blocked") return state;`).
  `ChatStream` reads it as
  `useInteractive((s) => activeSessionId ? s.agentState[activeSessionId] : undefined)`
  and feeds `composerLocked`:
  `const composerLocked = workingOrInTurn || agentState === "blocked" || compacting !== undefined;`
  where `workingOrInTurn = agentState === "working" || inTurn`.
- `requests: Record<string, InteractiveRequestData[]>` — "Pending interactive
  requests, keyed by the ACP session id." `InteractiveRequestData` has
  `requestId: string`, `method: "ask" | "confirm" | "password"`, `source:
  string`, `toolCallId?: string`, `params: Record<string, unknown>`. `send`/
  `flushHead` don't read it directly; `ChatStream`'s blocked derivation and the
  gate cards do.
- `isInteractivePause(method)` — exported predicate:
  `method === "ask" || method === "confirm" || method === "password"`.
- `dismissSession(sessionId)` — the only `session-closed` fan-out for this
  store (deletes `requests`/`todos`/`agentState`/`cost`/`session` keys); called
  by `lib/sessionLifecycle.ts`.

`send`/`flushHead` themselves read NO `interactive` action; they only read
`agentState` **indirectly through `composerLocked`** (the render-derived value).

### 3.2 `usePermissions` (zustand singleton, `src/store/permissions.ts`)

- `prompts: Record<string, PermissionPromptData[]>` — "Pending prompts, keyed by
  session id." `PermissionPromptData = { requestId: string; toolTitle: string;
  options: PermissionOption[] }`.
- Actions: `addPrompt(sessionId, requestId, request: PermissionRequest | unknown)`
  (dedups by `requestId`), `removePrompt(sessionId, requestId)`,
  `dismissSessionPrompts(sessionId)`. The capability SOURCE the dispatch path
  branches on is NOT this store: it is `activeCapabilities` from
  `useSessions`/`sessionFieldOf`, gated by `agentSupportsImages(...)` (imported
  from `../lib/chatAttachments`).

The prompt/pause lists are NOT read by `send`/`flushHead`; they feed the block
cards and, via `composerLocked`'s `agentState === "blocked"` term, the lock.

---

## 4. `src/hooks/useSessionIdleEdge.ts` — signature and contract

### 4.1 Signature

```ts
export function useSessionIdleEdge(opts: {
  /** The composite busy flag — pass `composerLocked` verbatim. */
  busy: boolean;
  /** Identity of the Session `busy` describes. A change to this is NEVER an edge. */
  key: string;
  onIdle: () => void;
}): void
```

### 4.2 Doc comment (verbatim)

```ts
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
```

### 4.3 Implementation (verbatim)

```ts
export function useSessionIdleEdge(opts: {
  busy: boolean;
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
```

Why the `key` re-seed prevents flushing the wrong session (quoting the code that
implements it): `const seen = useRef({ key: opts.key, busy: opts.busy })` +
`if (was.key !== opts.key) return;` — a `key` change re-seeds `seen` and returns
BEFORE the fall test, so a fall measured across two sessions never fires. The
call site passes `key: activeSessionId ?? ""`; `""` is the stable no-session
frame (pinned by the "a key change while idle → idle fires nothing (the
empty/no-session key is stable)" test).

### 4.4 Test pins (`src/hooks/useSessionIdleEdge.test.ts`)

File doc (verbatim): "The **Flush** trigger. Every assertion here is about ONE
thing: the callback fires on the falling edge of `busy` and on nothing else —
not on the first render of an idle Session, not on a rise, not twice for one
fall." Exact `it` names:

- "a first render with busy=false fires nothing (an already-idle mount is not an edge)"
- "a first render with busy=true fires nothing"
- "false → true fires nothing (rising is not idling)"
- "false → true → false fires exactly once"
- "staying idle across re-renders fires nothing more (one edge, one call)"
- "two consecutive busy episodes fire twice (the queue drains one per settle)"
- "remounting with busy=false fires nothing (the seed pin: a ref reset re-seeds, it is not an edge)"
- "remounting while busy=true, then going idle, fires once"
- "a key change with busy going true → false fires NOTHING (a Session switch is not a fall)" — comment: "THE H1 PIN."
- "a key change RE-SEEDS: a real fall inside the new key still fires"
- "a key change with busy staying true fires nothing, and the new key's fall fires"
- "a key change while idle → idle fires nothing (the empty/no-session key is stable)"
- "remounting on a new key with busy=false fires nothing (seed covers both)"
- "the edge calls the callback of the CURRENT render, not the one it mounted with" — asserts `seen` equals `["third"]`.

---

## 5. `src/lib/composerCommands.ts` + ADR 0044 — a command is CONSUMED

`Interface ComposerCommand` doc (verbatim):

```ts
/**
 * A **Composer command** — a `/name` the Client intercepts on send (ADR 0044).
 *
 * It is NOT a **Mention** (`$`/`@`/`#`, which EXPAND into a block on send,
 * ADR 0031) and NOT **File completion** (`?`, which inserts a PATH and expands
 * nothing, ADR 0033). A command is CONSUMED: no user row, no prompt, no model
 * call. The picker is shared with all three (one floating list, one token scan);
 * the meaning is not — which is why this registry is a separate module rather
 * than another field on the mention catalogs.
 */
```

Registry (verbatim): "Deliberately ONE entry: `/help`, fuzzy matching and arg
autocomplete were considered and rejected (ADR 0044), and a second command is
the change that re-opens this decision, not this one."

```ts
export const composerCommands: ComposerCommand[] = [
  { name: "compact", description: "Summarize the older context now" },
];
```

`parseComposerCommand` doc + signature (verbatim):

```ts
/**
 * Parse a draft as a **Composer command** (ADR 0044). `null` means "send it as
 * prose", and that fall-through is LOAD-BEARING, not courtesy: a **File
 * completion** file row consumes its `?` and inserts the absolute path verbatim
 * (ADR 0033/0035), so a draft can legitimately BEGIN `/etc/hosts ` or
 * `/home/you/notes.md `. A namespace that claims a leading `/` therefore has to
 * give back anything it does not recognize, BYTE-IDENTICALLY.
 *
 * The rules, each of which is pinned in `composerCommands.test.ts`:
 *  - the draft is `trim`ed first, and must then START with `/` (pi's rule: a
 *    leading `/` claims the message — `try /compact now` is prose);
 *  - the name is the run up to the FIRST whitespace, minus the `/`;
 *  - the args are everything after it, `trim`med;
 *  - the lookup is EXACT, so `/compactme` is prose rather than a near-miss —
 *    the same property ADR 0031's tag-safety rests on for a Mention. A bare
 *    `/` names nothing, so it is prose too.
 */
export function parseComposerCommand(text: string): ParsedCommand | null
```

`ParsedCommand = { name: string; args: string }` where `args` is "The text
after the name, trimmed — `""` when the command stood alone."

Guard tests (`src/lib/composerCommands.test.ts`, exact `it` names): "a bare / is
prose, not a command with an empty name"; "an unmatched /name is prose (EXACT
lookup, no fuzzy near-miss)"; "/compactme is prose — the name runs to
whitespace, never to a prefix match"; "a / that is not leading is prose (a
leading / claims the message)"; "a File-completion insert at position 0 is
prose (the load-bearing fall-through)"; "surrounding and repeated whitespace is
trimmed off both halves"; registry: "holds exactly one command: compact" and
"every command has a description for the picker's secondary line".

ADR 0044 (`docs/decisions/0044-the-composer-command-grammar.md`) consequences
that bound the extraction (verbatim): "A **Composer command** is a `/name` token
the **Client** intercepts on send: it runs a **Client**-side action and NOTHING
is sent to the **Agent**… a Composer command is CONSUMED: no user row, no
prompt, no model call." Plus: **an unmatched `/foo` MUST fall through
byte-identically as prose and that is load-bearing**; "ADR 0031's byte-identity
contract is deliberately narrower now. 'Live bubble = stored row = model input'
governs text that IS SENT; a Composer command sends nothing, so there is no
`mergeDedupeKey` to match and nothing to re-hydrate on resume"; "A command is
only ever typed while **idle**, because the composer is locked during a turn";
"`/compact` on a **stored (non-live)** session is a no-op with a one-liner".
The ADR's `## Consequences` also records the queue fork's contract: "A Stop does
not Flush and does not clear the queue, but the resulting
`turnCompleted("cancelled")` clears `inTurn`, which is half of the composite
busy flag whose falling edge triggers the **Flush**."

---

## 6. Mention expansion — `src/lib/skills.ts` exports used by the send path

- `expandMentions(text: string, c: MentionCatalogs): string` — the ONLY
  expansion the send path runs; pure; "No matched token → return `text`
  UNCHANGED (byte-identical, invariant 1; the function is pure — invariant 2,
  no mutation of inputs)". `MentionCatalogs = { skills: SkillInfo[]; agents:
  AgentDefinitionDto[]; mcpServers: McpServerInfo[] }`. `ChatStream` calls it
  with `{ skills, agents, mcpServers: mcpMentionsEnabled ? mcpServers : [] }`
  (the `#` gate is an EMPTY catalog, not a flag — an empty catalog makes
  `#` tokens match nothing, so the text stays byte-identical).
- `activeMentionToken(value: string, caret: number): { prefix: ComposerPrefix;
  remainder: string; start: number } | null` — the composer's live-caret token
  scan; `ComposerPrefix = "$" | "@" | "#" | "?" | "/"`. Not used by the send
  path itself, but by the picker that produces drafts `send` dispatches.
- `isOutsideSpaceQuery(remainder: string): boolean` — `remainder.startsWith("/")
  || remainder.startsWith("~/") || /^[A-Za-z]:\//.test(remainder)`.
- `dirPartOfOutsideQuery(remainder: string): string` — "The DIRECTORY part of an
  out-of-Space `?` remainder — the token's path up to and including its LAST
  `/`" (the catalog cache key).

**ADR 0031 byte-identity contract** (`docs/decisions/
0031-composer-mention-grammar-and-emergent-tag-safety.md`, `## Consequences`,
verbatim):

> **The persisted text IS the expanded text.** Expansion happens in `send()`
> before both `addUserMessage` and `sendPrompt`, so the live bubble, the stored
> row, and the model's input are byte-identical and `mergeDedupeKey` matches
> across a resume; `splitMentionBlocks` is display-only and degrades the WHOLE
> message to verbatim on any shape disagreement (a hostile `</agent>` inside a
> description truncates the parse and renders as plain text — no data loss, no
> display corruption).

And the RAW-draft-vs-catalog-of-that-moment rule is ADR 0069's own consequence
(verbatim): "A queued prompt holds the RAW draft; `expandMentions` runs at
send. So an edit made after queueing can retarget a `$name` **Mention** and
still expand correctly at its turn, and the bubble shows the token the user
typed rather than a skill body. It also preserves ADR 0031's byte-identity
contract by construction — the text that goes on the wire is produced by the
same call that always produced it."

Implementation detail the extraction must preserve (verbatim module doc of
`MENTION_RE`): "do NOT loop `exec`/`test` against the shared module-level regex
(a stale `lastIndex` across calls can drop mentions on repeat sends)" —
`expandMentions` uses `matchAll` "deliberately (NO shared-state `exec`/`test`
loop)". Also, `sendText` masks `[image #N]` markers out of the draft BEFORE
expansion and restores them byte-exactly AFTER it (`marks` / `\uE000` sentinel,
with a pasted-PUA collision guard), so the expansion sees no `#` token from a
marker.

---

## 7. The IPC surface the dispatch path uses (`src/lib/tauri`)

All five are plain `invoke` wrappers in `src/lib/tauri/commands/*`; the
**only public surface is `src/lib/tauri.ts`** (the barrel) — the commands files
carry the standing warning (verbatim): "NOTHING outside `src/lib/tauri/`
imports this file — `src/lib/tauri.ts` is the only public surface, and
`src/lib/tauriBarrel.test.ts` enforces it. The reason is the test seam: 35 test
files `vi.mock("@/lib/tauri")` BY MODULE PATH…"

- `sendPrompt(sessionId: string, text: string, images?: ImageRef[]): Promise<StopReason>`
  — `invoke<StopReason>("send_prompt", { sessionId, text, images: images ?? [] })`.
  **Returns the turn's `StopReason`** when the turn settles (including
  `"cancelled"` when Esc raced it). `ChatStream` passes the third argument ONLY
  when images exist: `imageRefs ? await sendPrompt(sessionId, text, imageRefs) :
  await sendPrompt(sessionId, text)` — "an explicit `undefined` third arg would
  break [the existing tests]" (vitest compares arg arrays by length).
- `compactSession(sessionId: string, instructions: string | null): Promise<boolean>`
  — "`false` is the NOT-LIVE answer, not an error… `true` means the frame was
  actually written." `instructions` pass-through is verbatim: "the Rust
  parameter is `Option<String>`, so `""` is a different instruction to the
  harness than `None`" (hence `command.args || null`).
- `cancelSession(sessionId: string): Promise<void>` — "Cancel the session's
  in-flight prompt turn (Esc). The agent resolves the open prompt with
  `stopReason: "cancelled"`."
- `readFileBytes(path: string): Promise<number[] | null>` — "A picked file's
  bytes… `null` when the file is not a supported image (the picker's allowlist —
  the frontend skips it silently); a rejected Promise when the file cannot be
  read (e.g. over the 10 MiB cap…)".
- `readClipboardImage(): Promise<number[] | null>` — "The current
  system-clipboard image (if any) as PNG bytes… `null` when the clipboard has
  no image (text-only or empty)." WebKitGTK fallback for pasted images.

`resumeSession(sessionId: string, cwd: string): Promise<SessionInfo>` is the
companion command the `resume` path uses (via the store action).

`describeIpcError` (`src/lib/ipcError.ts`, zero imports, total):

```ts
export function describeIpcError(err: unknown): string
```

Resolution order (verbatim): 1. `typeof err === "string"` → `err` (`Err(String)`
— "the wire error IS the message"); 2. `err instanceof Error` → `err.message`;
3. plain object → typed envelope `message` (guaranteed string, ADR 0063), else
`kind`; 4. `stringify(err)` last resort, with the `"[object Object]"` sentinel
mapped to `"unknown error"`. Doc: "The envelope and the resolution order below
are a cross-language contract, not an implementation detail: ADR 0063… never
build prose from `kind`, translate it, or pattern-match its values here."

`IpcErrorLine` (`src/components/IpcErrorLine.tsx`):

```ts
export function IpcErrorLine({
  error,
  className,
  as: Element = "p",
}: {
  error: string | null | undefined;
  className?: string;
  as?: "p" | "span";
}): ReactElement | null
```

`if (!error) return null;` — no error → no element; otherwise renders
`<Element role="alert" className={cn("text-ui-sm text-destructive", className)}>{error}</Element>`.
`ChatStream` renders `{error && <IpcErrorLine error={error} className="mb-2 px-3" />}`
and stores the string via `setError(describeIpcError(err))`. The component is
the consumer of the string; `send`/`flushHead` are producers.

---

## 8. The event channel — who owns the subscription today

### 8.1 `src/lib/ipc/events.ts`

`IPC_EVENTS` (verbatim):

```ts
export const IPC_EVENTS = {
  sessionUpdate: "session-update",
  sessionClosed: "session-closed",
  sessionStalled: "session-stalled",
  sessionTitled: "session-titled",
  permissionRequest: "permission-request",
  interactiveRequest: "interactive-request",
  interactiveRequestClose: "interactive-request-close",
  interactiveEvent: "interactive-event",
  subagentSessionStarted: "subagent-session-started",
  subagentClosed: "subagent-closed",
  windowStateChanged: "window-state-changed",
  updateProgress: "update://progress",
  insertSkill: "archimedes:insert-skill",
} as const;
```

Relevant to turn completion: **`sessionUpdate: "session-update"`** (the
`session/update` frame stream the transcript renders; NOT the turn-completion
signal — see 8.2), and the interactive discriminants
`INTERACTIVE_EVENTS = { todosUpdate: "todos_update", todosClear: "todos_clear",
state: "state", costUpdate: "cost_update", session: "session" }`. Two rules from
the module doc (verbatim): "1. **A constant's VALUE is the wire contract.**
Never change one to satisfy a style preference. `events.test.ts` pins every
value byte-for-byte…" and "2. There is no Rust-parity test here, and there must
never be one."

### 8.2 There is NO `turnCompleted` event from the backend

The **`turnCompleted` store action is called by the DISPATCH PATH ITSELF**, not
by any event listener: `sendPrompt` resolves with the `StopReason` and
`ChatStream`'s success/catch arms call `turnCompleted`; `flushHead` does the
same with its own settle. The harness emits the `agent_settled` RpcEvent
Rust-side (e.g. `src-tauri/src/agent/harness/loop.rs` — "self.emit(
RpcEvent::agent_settled)") as an agent-side signal; on the frontend the
completion signal is the **`send_prompt` invoke resolution**, plus the
`state → "idle"` `interactive-event` (stored by `applyState`, read through
`agentState`). The wire's `agent_message_chunk` frames are all that ride
`session-update`; the store's `applySessionUpdate`/`applySessionUpdates` never
touch `inTurn`.

### 8.3 `src/App.tsx` owns every subscription; no hook subscribes

`App.tsx`'s one `useEffect(() => { … }, [])` registers ALL listeners
(verbatim): "Register the Tauri event listeners once; dispatch into the
stores." Each push is wired to a store action: `listenSessionUpdate` →
`batchedSessionUpdate({ sessionId, update })` →
`useSessions.getState().applySessionUpdates(items)` (one React render per frame,
`requestAnimationFrame` batching); `listenSessionClosed` →
`onSessionClosed(payload.sessionId, payload.reason)`; `listenSessionStalled` →
`markStalled`; `listenSessionTitled` → `titleSession`;
`listenPermissionRequest` ��� `usePermissions.addPrompt`;
`listenInteractiveRequest` → `useInteractive.addRequest`;
`listenInteractiveRequestClose` → `removeRequest` + `removePrompt`;
`listenInteractiveEvent` → the exhaustive `switch` on `INTERACTIVE_EVENTS`
(→ `applyTodoUpdate` / `applyTodoClear` / `applyState` / `applyCost` /
`applySession`); `listenSubagentSessionStarted` / `listenSubagentClosed` → the
subagents store. **Subscriptions are app-owned, view-independent** (verbatim):
"session running in the background keeps streaming into the stores (the listener
`useEffect`s above are view-independent), and the `SpacesList` / `ChatStream` /
`SidePane` re-read them on remount."

`lib/sessionLifecycle.ts`'s `onSessionClosed(sessionId, reason)` is the close
fan-out; relevantly for the queue (verbatim):

```ts
  // ADR 0069: a reopened Session must not offer a Flush whose turn can never
  // arrive — the queue goes with the close, which is also what owns (and so
  // releases) the queued attachments' object URLs.
  useQueuedPrompts.getState().clearSession(sessionId);
```

`useSessions`' `deleteSession` also calls `clearSession` (the delete path has no
`onSessionClosed` fan-out — cited comment verbatim: "A DELETE has no
`onSessionClosed` to fan out through, so the queue is dropped here…").

**Conclusion for the planner**: a hook extracted from `ChatStream` must NOT
subscribe to any Tauri event. Turn completion is the resolution of the
`sendPrompt`/`sendText` promise; the busy flag is derived from store state;
`App` owns the listeners.

---

## 9. Existing tests pinning dispatch/flush behaviour

### 9.1 `src/components/ChatStream.test.tsx` — the three relevant groups

Exact `describe` strings:

- `describe("ChatStream — the /compact Composer command (ADR 0044)", () => {` —
  `it` names: "the / picker lists the command with its description, and never a
  skill"; "selecting the command row inserts `/compact ` (selectMention's
  existing fall-through)"; "/compact dispatches compact_session with null
  instructions and sends nothing"; "/compact <args> reaches compact_session as
  the instructions"; "a non-live answer (false) adds ONE system-style line with
  its own messageId"; "/compact on a RESUMABLE stored session does not resume it
  (ADR 0044)"; "an unmatched /name sends BYTE-IDENTICALLY (the File-completion
  insert fall-through)".
- `describe("ChatStream — send() forks to the prompt queue while the composer is locked", () => {` —
  `it` names: "Enter while inTurn queues the draft instead of sending it";
  "queues a mention-bearing draft RAW (expansion runs at send, per ADR 0069)";
  "an empty draft while locked stays a silent no-op (nothing to queue)"; "a
  marker-only draft with no attachments while locked queues nothing"; "a
  Composer command while locked is NOT queued — it answers with a line"; "a
  locked send MOVES the staged attachment into the entry (no revoke, empty
  strip)"; "a locked send queues on the `blocked` and `compacting` locks too
  (all three lock sources)"; "the turn ending FLUSHES the queue (the busy→idle
  edge is the Flush's trigger)"; "an unlocked send still dispatches and queues
  nothing (the regression pin)".
- `describe("ChatStream — the Flush: the queue drains when the Session goes idle", () => {` —
  `it` names: "a busy→idle fall sends the queue head as an ordinary prompt";
  "the Flush runs `sendText`, so a queued Mention expands at send (not at
  enqueue)"; "one settle sends ONE entry and the next settle sends the next
  (queue order)"; "a failed Flush puts the entry back at the head marked
  `failed` and sends EXACTLY once"; "saving an edit of the failed entry makes it
  flushable again"; "a prompt queued during an IDLE compaction flushes when the
  compaction ends"; "a successful Flush RELEASES its attachment's object URL";
  "a Flush to an agent that cannot take images sends TEXT-ONLY (fail-closed)";
  "renders with no active session without crashing, and still flushes once one
  appears"; "a Session switch away from a BUSY session does NOT flush the
  arrived-at Session's queue"; "a Flush whose attachment READ fails settles NO
  turn and keeps the previous stop reason".

(The file's remaining queue-related groups: "ChatStream — the failed-send
attachment restore", "ChatStream — staging attachments is allowed while a turn
is in flight", "ChatStream — the empty-state film beside a non-empty prompt
queue"; the last two `it`s: "keeps the empty-state cue and the queue rows both
rendered and separate" and "does not render the film while a turn is in flight
(the queue's own state)".)

### 9.2 Assertions that break if the queue-fork ORDER inside `send` changed

The fork sits BEFORE `sendingSessionsRef` and before the `try` —
"a queueing press never occupies the double-send slot (and, because it returns
ahead of the `try`, it must not rely on the `finally` for cleanup — and it
needs none: `setDraft`/`setAttachments` are its only effects)". Assertions that
pin the order:

- "a Composer command while locked is NOT queued — it answers with a line" —
  asserts `queue()).toHaveLength(0)` AND one `agent-text` row
  `"/compact runs when this turn ends — try again then."` AND the draft
  untouched (`composerValue()).toBe("/compact ")`). If the command parse moved
  AFTER enqueue (or if `/compact` were queued), both assertions fail.
- "the turn ending FLUSHES the queue (the busy→idle edge is the Flush's
  trigger)" + "one settle sends ONE entry and the next settle sends the next
  (queue order)" — if the fork ran AFTER `sendingSessionsRef.add` (i.e. if a
  queueing press held the slot), the turn's own settle would find the slot
  occupied and never flush; "one settle sends ONE entry…" (with the deferred
  `sendPrompt`) pins that the flush's own in-flight send blocks the next entry
  until ITS settle — one per settle, exactly.
- "an unlocked send still dispatches and queues nothing (the regression pin)"
  — pins the fork is gated on `composerLocked` only.
- "a failed Flush puts the entry back at the head marked `failed` and sends
  EXACTLY once" — the count pin; and the requeue's `failed: true` is what makes
  the self-inflicted settle edge (the flush's own `turnCompleted("end_turn")`)
  find nothing to send. If `requeueHead` ran BEFORE `turnCompleted` (or the
  flag were absent), the `expect(sendPrompt).toHaveBeenCalledTimes(1)` breaks
  (retry loop).
- "a Flush whose attachment READ fails settles NO turn and keeps the previous
  stop reason" — pins the `dispatched` flag: `stopReasons["s1"]` must stay
  `"max_tokens"` and the footer "Turn ended: max_tokens" must stay on screen.
- "renders with no active session without crashing, and still flushes once one
  appears" — pins `useSessionIdleEdge` BEFORE the `!activeSessionId` early
  return (the hook-count crash). Any extraction must keep that hook (or its
  functional equivalent) in the unconditional top block.

### 9.3 `src/store/queuedPrompts.test.ts`

Existing coverage (`describe` + `test` names): `enqueue` ("appends and preserves
order (the array order IS the send order)"; "keeps the raw text and the moved
attachments as given"); `takeHead` ("returns the first LIVE entry and marks it
leaving: \"sent\" without removing it"; "a second takeHead skips the entry
already leaving and returns the next"; "returns undefined for an unknown
session"; "returns undefined and changes nothing when every entry is leaving";
"skips a failed entry and returns undefined when every live entry failed"; "a
failed entry ahead of a healthy one yields the turn to the one behind it";
"skips an entry being edited and returns the one behind it"; "returns undefined
when the only live entry is being edited"); `requeueHead` ("puts the entry back
at the FRONT with leaving cleared and does not release its attachments";
"inserts NOTHING for a session whose key no longer exists (a closed Session
stays clean)" — comment: "THE ORPHAN PIN"); `markLeaving` ("hides an entry from
takeHead while keeping it in the list, mounted for its exit"; "releases nothing
on its own"; "is a NO-OP for an entry that is already leaving (one entry, one
exit owner)"; "is a NO-OP for an entry already leaving as deleted (the exit is
not re-triggered)"); `updateText` ("changes only the text"; "on a failed entry
clears failed (saving an edit IS the retry gesture)"; "leaves an unknown id
alone"); `setEditing` ("changes only state, and does NOT clear failed (opening
the editor is not a retry)"; "is a NO-OP for an entry that is already leaving (a
row animating out is not a control)"); `removeAttachment` ("drops just that
attachment and releases its object URL"; "leaves text, state and leaving
untouched"; "an unknown attachment id releases nothing"); `forget` ("removes
the entry by id"; "deletes the bySession key when the list empties"; "releases
every attachment of a deleted entry"; "does NOT release the attachments of a
sent entry (the send path owns them)"); `clearSession` ("releases every
attachment it drops (both leaving values) and deletes the key"; "is a no-op for
an unknown session"); `session isolation` ("two sessions' queues never
interfere").

### 9.4 `src/hooks/useSessionIdleEdge.test.ts`

See §4.4 (all 14 `it`s quoted).

---

## 10. The double-send guard contract — `sendingSessionsRef`

Declaration (verbatim, `src/components/ChatStream.tsx`):

```tsx
  // Task 5's double-send guard (a hook — must live here, not in `send`):
  // `beginTurn` runs AFTER an `await` (the base64 read), so the composer is
  // not locked until then and a second Enter/click during the read would
  // otherwise double-send. Keyed by session ID (a `Set`) so an in-flight
  // turn in session A never blocks sending in session B (concurrent sessions).
  const sendingSessionsRef = useRef<Set<string>>(new Set());
```

Shared by `send` and `flushHead` (verbatim, in `flushHead`):

```tsx
    // `sendingSessionsRef` is the same double-send slot `send()` uses: a manual
    // send already in flight owns this session, and a **Flush** must not race it
    // into a second `send_prompt` (the harness's `pending_turn` claim is atomic
    // and refuses the loser).
    if (!sessionId || sendingSessionsRef.current.has(sessionId)) return;
```

The invariant BOTH callers must preserve:

1. **Claim** — `add(targetSessionId)` on entering the dispatch try-block (only
   after the locked-fork returned) in `send`; `add(sessionId)` after `takeHead`
   succeeded in `flushHead`. `send` checks `if
   (sendingSessionsRef.current.has(targetSessionId)) return;` BEFORE adding;
   `flushHead` checks the same before taking the head.
2. **Release in `finally`** — `sendingSessionsRef.current.delete(...)` in one
   `finally`, on every exit. `flushHead`'s `takeHead`+`add` are synchronous
   (the store's contract, §1.4), so the check-and-add pair is atomic against a
   racing manual send.
3. **Every early `return` inside `send`'s body must go through that `finally`**
   — the failure mode is documented in `send`'s command block (verbatim): "an
   early `return` above the `try` would leave the session stuck in the set and
   silently break EVERY later send — **the composer would look alive and never
   fire**."

What happens if a hook boundary breaks it: a session id left in the set (a
`try`→`finally` shape not preserved — e.g. an extracted hook that claims the
slot in one component and releases in another, or a `return` moved before a
recreated `try`) makes every later `send()` and every later `flushHead()`
short-circuit at the `has(...)` guard, so the composer's Send/Enter appears to
do nothing (or the queue never drains) with no error and no re-enable — the
exact "composer looks alive and never fires" symptom. Conversely, TWO separate
refs (one per hook) would defeat the guard: `send` and `flushHead` must share
ONE `Set` instance, because the race they bound is between the two paths (a
manual send in flight owning the session while the flush takes the head).

---

## 11. Verification commands

Repo root is `/home/daniel/Coding/AI/archimedes-desktop`; the frontend
validates from the ROOT (`pnpm`), the Rust backend from `src-tauri/` (`cargo`).
From `package.json`: `"test": "vitest run"`, `"build": "tsc && vite build"`.
From the Makefile headers: "The project validates from TWO roots… A branch is
ready to merge when `make check` is green." `make check` is
`cargo fmt --check` → `cargo clippy --all-targets` → `cargo test` → `pnpm build`
→ `pnpm test` (sequential, fast-fail).

Targeted commands (run from the repo root unless stated):

- `pnpm exec vitest run src/components/ChatStream.test.tsx` — the three groups
  of §9.1 plus the queue-adjacent staging groups.
- `pnpm exec vitest run src/store/queuedPrompts.test.ts` — the store API
  (§9.3).
- `pnpm exec vitest run src/hooks/useSessionIdleEdge.test.ts` — the edge hook
  pins (§9.4).
- `pnpm exec vitest run src/lib/composerCommands.test.ts` — the command grammar
  + "exactly one command" registry.
- `pnpm exec vitest run src/lib/skills.test.ts` — mention expansion / tag-safety
  byte-identity pins.
- `pnpm exec vitest run src/lib/ipc/events.test.ts src/lib/tauriBarrel.test.ts
  src/lib/ipcError.test.ts src/lib/chatAttachments.test.ts` — wire names, the
  tauri barrel seam, `describeIpcError`, attachment helpers.
- Full frontend gate: `pnpm test` (all of the above together); type-check +
  build gate: `pnpm build` (`tsc`).
- Whole-repo merge bar: `make check` (from the repo root; runs the Rust side
  too).
