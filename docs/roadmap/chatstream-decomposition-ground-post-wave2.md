---
status: grounding-report
title: "chatstream-decomposition — post-wave-2 delta (what the attachment hook changed under task04's seam)"
base: 27cec040
head: 77cb4f1a
code_head: 0aa99ffb
branch: feature/chatstream-decomposition
generated: 2026-11-01
supersedes: none of the four area reports nor post-wave1 — READ THIS ALONGSIDE post-wave1 and prompt-queue-stores, which remain accurate
---

# Post-Wave-2 delta — `useChatAttachments` landed, five call sites inside `send` re-pointed

Wave 2 (commit `0aa99ffb` = task B1, the `useChatAttachments` extraction; merged at code HEAD `0aa99ffb`, docs HEAD `77cb4f1a`) changed exactly four files:

- `src/hooks/useChatAttachments.ts` — NEW, 539 lines.
- `src/hooks/useChatAttachments.test.tsx` — NEW, 947 lines, 35 tests.
- `src/components/ChatStream.tsx` — 1488 → **1206** lines at HEAD (`wc -l` = 1206).
- `src/components/ChatStream.test.tsx` — 7673 → **7140** lines (`wc -l` = 7140), 244 tests.
- `src/lib/tauriBarrel.test.ts` — mock-seam pin bumped (see §7).

Everything task04's planner needs that is NOT listed below is unchanged from `prompt-queue-stores.md` (stores, turn lifecycle, `useSessionIdleEdge`, `lib/composerCommands`, mention expansion, the IPC surface — all accurate, those files are untouched) and `post-wave1.md`. Verify nothing below against earlier reports; this delta is stricter and supersedes only what it names. **Every line number below was re-measured at `77cb4f1a` / code `0aa99ffb`.**

---

## 1. `useChatAttachments`'s landed public surface — the boundary task04 must consume

`src/hooks/useChatAttachments.ts`, **the real, landed signatures** (quote the file, NOT the plan — the plan's `UseChatAttachmentsArgs` omitted `setError`):

```ts
export interface UseChatAttachmentsArgs {
  setDraft: (value: string) => void;
  setError: (value: string | null) => void;
  draftRef: RefObject<string>;
  activeSessionIdRef: RefObject<string | null>;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  imageCapable: boolean;
  composerEnabled: boolean;
}
```

```ts
export interface UseChatAttachmentsResult {
  attachments: ChatComposerAttachment[];
  attachmentsRef: RefObject<ChatComposerAttachment[]>;
  stageFiles: (files: File[]) => void;
  handlePaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  handleDrop: (e: DragEvent) => void;
  handleAttachClick: () => Promise<void>;
  removeAttachment: (id: string) => void;
  moveOutForSend: (targetSessionId: string, sentIds: Set<string>) => void;
  restoreHeldForSend: (
    targetSessionId: string,
    errorMsg: string,
    setError: (value: string | null) => void,
    setDraft: (value: string) => void,
  ) => void;
  releaseHeldForSend: (targetSessionId: string) => void;
  clearAll: () => void;
  clearStaged: () => void;
}
```

**The 12 returned names** (the surface-pin test in `useChatAttachments.test.tsx` at line 350–351 asserts exactly this sorted list — `attachments, attachmentsRef, stageFiles, handlePaste, handleDrop, handleAttachClick, removeAttachment, moveOutForSend, restoreHeldForSend, releaseHeldForSend, clearAll, clearStaged`).

**`attachmentsRef` is exposed as a LIVE ref**: the hook does `attachmentsRef.current = attachments` every render (line 170), and `send` reads `attachmentsRef.current` mid-async in exactly three places — the `liveIds` reconcile (line 825), the locked-fork's `const moved = attachmentsRef.current` (line 730), and the restore's merged-list (inside `restoreHeldForSend`). The hook OWNS the raw `setAttachments` and the `heldForSendRef` map — neither is returned ("who may revoke an object URL" stays inside the module). The five landed function bodies:

- `moveOutForSend(targetSessionId, sentIds)` — filters `attachmentsRef.current` into the held map, leaves the held ones in `heldForSendRef`, writes back the non-sent subset, `setAttachments`. The sent subset LEAVES the composer AT send, held NOT released (a failed send puts them back).
- `restoreHeldForSend(targetSessionId, errorMsg, setError, setDraft)` — the failed-send restore: merges the held list IN FRONT of whatever is staged now, de-dupes by `id`, respects `MAX_CHAT_ATTACHMENTS` (releases the overflow), shifts the draft's markers by the number ACTUALLY restored (`if (back.length > 0) { setDraft(shiftImageMarkers(draftRef.current, back.length)); }` — the shift guard stays INSIDE the held block), deletes the map entry UNCONDITIONALLY, and lands `setError(errorMsg)` only when `activeSessionIdRef.current === targetSessionId`. **It is ONE synchronous call** — the restore, the shift and the error line land in one React 19 batch.
- `releaseHeldForSend(targetSessionId)` — releases the held list + drops the map entry (send SUCCESS path; session-switch / unmount cleanups). Never touches the live list.
- `clearAll()` — session switch: release + clear the STAGED list.
- `clearStaged()` — the ADR-0069 queue-fork's staged clear: empties the staged list (ref + state) **WITHOUT releasing the object URLs** (they MOVE with the text into the queue entry).

**Critical for the task04 planner reading the plan rather than the file:** the plan's `UseChatAttachmentsArgs` (task03's) omitted `setError`. It landed as an ARGUMENT — `stageFiles` (line 249: `setError(rejected.length > 0 ? rejected.join("; ") : null);`), `handleAttachClick` (line 383: `setError(readError);`), and the restore path (the `setError` parameter of `restoreHeldForSend`) all call it, while `ChatStream` keeps owning the `error` cell. Task04's dispatch hooks receive the attachment functions through the returned result, NOT through the args — but if a planner copies the args interface from task03's plan, it will produce a hook `ChatStream` cannot call. **The six args above are the real contract, and `setError` is one of them.**

**One name is conspicuously absent from `ChatStream`'s destructure:** `stageFiles`. It is still RETURNED (12-name pin), but `ChatStream` does not destructure it — its only callers were the three staging handlers, all of which moved with it into the hook. The 11 names `ChatStream.tsx` actually destructures (lines 279–292): `attachments, attachmentsRef, handlePaste, handleDrop, handleAttachClick, removeAttachment, moveOutForSend, restoreHeldForSend, releaseHeldForSend, clearAll, clearStaged`. (`stageFiles` absent is proven by `noUnusedLocals`, per the comment at lines 276–278.)

---

## 2. The five re-pointed call sites inside `send`, quoted with context — what task04 must do with each

These are the five places wave 2 rewrote inside `send`'s body. **They now cross a module boundary**: `send` is moving into `useChatPromptDispatch`, so the attachment functions become ARGUMENTS of the new dispatch hook. `ChatStream` currently hands them in by destructuring the hook call; `useChatPromptDispatch` must RECEIVE them (plus `setDraft`/`setError`/`draftRef`/`activeSessionIdRef`/the capability gates — see §4).

### 2a. The locked-composer fork's `clearStaged()` — lines 724–740

```tsx
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
```

What task04 must do: the fork's order is load-bearing and pinned — (1) read `attachmentsRef.current` into `moved` FIRST, (2) `clearStaged()` (non-revoking — the ADR-0069 "URLs MOVE with the text" contract; `URL.revokeObjectURL` must NOT be called anywhere in this fork), (3) enqueue with `attachments: moved`, (4) `setDraft("")`, (5) return. The `const moved = attachmentsRef.current` read and the `clearStaged()` call are TWO of the `useChatAttachments` handles the new hook must receive. This fork sits BEFORE `sendingSessionsRef` and before the `try` — it must never occupy the double-send slot.

### 2b. `moveOutForSend(targetSessionId, sentIds)` in the onCommitted path — lines 858–876

```tsx
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
```

What task04 must do: `onCommitted`'s FIRST statement is `setDraft("")` (the failed-send tests' premise "the text typed before Send is lost" depends on it); then the held move `moveOutForSend(targetSessionId, sentIds)` guarded by `sentIds.size > 0 && activeSessionIdRef.current === targetSessionId`. This is the `onCommitted` callback the new dispatch hook builds — it needs `setDraft`, `moveOutForSend`, and `activeSessionIdRef` in scope. The `activeSessionIdRef` guard is preserved verbatim.

### 2c. `releaseHeldForSend(targetSessionId)` on success — lines 885–891

```tsx
      // Success: the turn settled, so the held attachments have no job left —
      // release them for good and drop the map entry. Released from the HELD
      // list (they left `attachments` at send), NOT by re-filtering the staged
      // list by `sentIds`. The state is untouched here: the composer is
      // already clean, so only the `activeSessionIdRef`-guarded map entry has
      // to go (the held objects are released either way — a revoked URL is not
      // session-scoped).
      releaseHeldForSend(targetSessionId);
      turnCompleted(targetSessionId, stopReason);
```

What task04 must do: the success path — `releaseHeldForSend(targetSessionId)` then `turnCompleted(targetSessionId, stopReason)`, in that order. The release is from the HELD list, NOT by re-filtering the staged list. `useChatPromptDispatch` receives `releaseHeldForSend` as an argument and calls it after the `sendText` await (and after the `stopReason === null` early return — see below).

### 2d. `restoreHeldForSend(targetSessionId, msg, setError, setDraft)` in the catch — lines 893–915

```tsx
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
```

What task04 must do: `turnCompleted(targetSessionId, "end_turn")` runs FIRST in the catch (each caller owns its own settle); then `describeIpcError(err)`; then `restoreHeldForSend(targetSessionId, msg, setError, setDraft)` — the WHOLE restore block is one synchronous call. The `finally` deletes `targetSessionId` from `sendingSessionsRef`. Note `setError` is passed to `restoreHeldForSend` here as an argument — `useChatPromptDispatch` must receive `setError` (the component owns the `error` cell) so it can hand it to the restore.

**Net: what `useChatPromptDispatch` must therefore RECEIVE** (the attachment functions it can no longer close over, because they are returned from `useChatAttachments` in `ChatStream`'s unconditional block):

- `setDraft`, `setError` (component setters — the hook owns neither cell),
- `draftRef`, `activeSessionIdRef` (live refs — the hook needs the same handles `send` reads),
- the capability gates `imageCapable` / `composerEnabled` (values, from `useChatSessionDerivations` — see post-wave1 §1),
- the attachment-boundary functions: `attachmentsRef`, `moveOutForSend`, `restoreHeldForSend`, `releaseHeldForSend`, `clearStaged` (plus, if the flush hook needs the queue-entry URL release, `releaseAttachment` and the `readAttachmentAsBase64` / `SendTextImages` pieces stay component-side or are threaded too — but `flushHead` currently releases the QUEUE ENTRY's copy via `entry.attachments.forEach(releaseAttachment)` directly, NOT through the hook; see §4),
- and the double-send slot + flush ref it shares with `usePromptQueueFlusher` (§4).

The fifth "call site" is not one of these four — it is `attachmentsRef.current` read in the fork (2a) AND in the `liveIds` reconcile (line 825: `const liveIds = new Set(attachmentsRef.current.map((a) => a.id));`). Both read the same live ref; the new dispatch hook must be handed `attachmentsRef`, not a snapshot.

---

## 3. Current spans (orientation only; symbols named in prose)

`src/components/ChatStream.tsx` = **1206 lines** at HEAD (`wc -l`). Re-measured at `77cb4f1a` / code `0aa99ffb`:

| Symbol | Current lines | Notes |
|---|---|---|
| `sendText` | 546–683 | body byte-identical to `27cec040` (see §4) |
| `send` | 685–916 | the only seam whose BODY changed — the 4 re-points of §2 (the fork comment at 704–708 is the fifth hunk; see §4) |
| `flushHead` | 924–1037 | body byte-identical (the `flushRef.current = () => { void flushHead(); }` assignment at 1044–1047 is a SEPARATE statement after `flushHead`, outside the seam) |
| `resume` | 1050–1068 | body byte-identical; the single "hunk" near it is a comment (see §4) |
| `if (!activeSessionId)` early return | 509–522 (the no-session `<main>` frame through line ~520) | the first hook AFTER it would be a conditional hook call |
| unconditional hook block | line 63 (`const activeSessionId = useSessions((s) => s.activeSessionId);`) through line 507 (`useSessionIdleEdge`'s `});`), the last hook before the early return | now holds TWO extracted hooks |
| Esc effect | 316–330 (`}, [inTurn, activeSessionId, compacting]);`) | effect 1 |
| session-switch effect | 332–350 (`}, [activeSessionId]);`) | effect 2 — calls `clearAll()` (340) and `releaseHeldForSend(left)` (347); `prevSessionIdRef` declared at 331 |
| `useWindowDropBackstop()` | 356 | effect 3 (extracted hook) |
| `useAutoGrowComposer(composerRef, draft)` | 357 | effect 4 (extracted hook) |

The unconditional block's TWO extracted hooks:
- `useChatSessionDerivations()` destructure at lines 86–94 (the 9 names: `askRequests, confirmRequests, passwordRequests, stackedAskRequests, isLive, canResume, composerEnabled, turnDiffs, imageCapable`).
- `useChatAttachments({...})` call at lines 279–298, destructuring 11 names at 279–292, with the six args `setDraft, setError, draftRef, activeSessionIdRef, composerRef, imageCapable, composerEnabled`.

`hasImages` (the `let`, re-derived after `resume()`) sits at line 528: `let hasImages = attachments.length > 0 && imageCapable;`. The `SendTextImages` type is exported at lines 49–58 ("Exported because Task 5's Flush builds one" — the comment names Task 5, i.e. task04's flush hook is expected to build it).

---

## 4. `sendText` / `flushHead` / `resume` unchanged since `27cec040`; the double-send guard + flush seam as they now stand

### Zero changed hunks in `sendText` and `flushHead` bodies — CONFIRMED

`git diff 27cec040 HEAD -- src/components/ChatStream.tsx` = 11 unified hunks, all in wave 2's extraction. The only hunks that touch the seam region are the four re-points of §2 plus the fork-comment tweak (line 707). `sed`-extraction `diff` of the exact spans:

- `sendText` new 546–683 vs old 553–691 → **identical** (only a trailing blank line differs — the closing `};` line is preserved).
- `flushHead` new 924–1037 vs old 988–1112 → **identical** (the `flushRef.current = () => { void flushHead(); }` block that was at old 1113–1120 is now a separate statement at new 1039–1047, OUTSIDE the function body; the `flushHead` body itself is byte-identical).
- `resume` new 1050–1068 vs old 1114–1127 → **identical body**. The single hunk near it is a comment ABOUT the moved derivations, not a body change. Current `resume` body (quote for the dispatch planner — unchanged from post-wave1 §2):

```tsx
  const resume = async (): Promise<boolean> => {
    if (!activeSessionId || resuming) return false;
    setResuming(true);
    setError(null);
    try {
      await resumeSession(activeSessionId);
    } catch (err) {
      setError(describeIpcError(err));
      return false;
    } finally {
      setResuming(false);
    }
    return true;
  };
```

### The double-send guard and the flush seam, as they now stand

All four refs are declared in `ChatStream`'s unconditional block and shared by the seams:

- **`sendingSessionsRef`** — declared line 250: `const sendingSessionsRef = useRef<Set<string>>(new Set());` (comment at 248–249: "Task 5's double-send guard … Keyed by session ID (a `Set`) so an in-flight turn in session A never blocks sending in session B"). Read by: `send` (line 741 guard `if (sendingSessionsRef.current.has(targetSessionId)) return;`, line 742 add, line 914 `finally` delete) AND `flushHead` (line 934 guard `if (!sessionId || sendingSessionsRef.current.has(sessionId)) return;`, line 940 add, line 1035 `finally` delete).
- **`flushRef`** — declared line 494: `const flushRef = useRef<() => void>(() => {});`. The trigger hook (below) reads it; `flushRef.current = () => { void flushHead(); }` assigned at lines 1044–1047 (a plain render-phase assignment, part 2 of the trigger, AFTER `flushHead` is declared).
- **`activeSessionIdRef`** — declared line 257, re-synced every render at 258: `activeSessionIdRef.current = activeSessionId;`. Read by: `send` (lines 828, 837, 872), `flushHead` (lines 929, 1033), the paste-fallback guard (now inside `useChatAttachments` via its `activeSessionIdRef` argument), `restoreHeldForSend` (internal re-check), and the fork comment.
- **`draftRef`** — declared line 264, re-synced at 265: `draftRef.current = draft;`. Read by: `send`'s stale-draft guard (line 844), `stageFiles`/`removeAttachment` (inside the attachment hook via its `draftRef` argument), `restoreHeldForSend`'s marker shift, and `useMentionPicker` (line 466).

**The flush seam — quote the current call** (lines 503–507, the LAST hook before the early return):

```tsx
  useSessionIdleEdge({
    busy: composerLocked,
    key: activeSessionId ?? "",
    onIdle: () => flushRef.current(),
  });
```

### What task04 must split across TWO new hooks, and which refs BOTH hooks need

`useChatPromptDispatch` (takes `sendText`/`send`/`resume`) and `usePromptQueueFlusher` (takes `flushHead`) share the ONE `sendingSessionsRef` Set — the double-send invariant (prompt-queue-stores §10) is that a manual send in flight owns the session while the flush takes the head, so **both hooks must receive the SAME `Set` instance**. Split across two hooks WITHOUT breaking the one-Set invariant means:

- **Both hooks need `sendingSessionsRef`** (the one shared Set — a second ref would defeat the guard: `send` and `flushHead` must bound the race between the two paths).
- **Both hooks need `activeSessionIdRef`** (`send` reads it mid-async; `flushHead` reads it for the Visible-Session rule and the error-line guard).
- **Both hooks need `flushRef`** — but they sit on opposite ends of it: the dispatch side does NOT read it (only `useSessionIdleEdge` does, through `onIdle`), and the flush side must ASSIGN it (`flushRef.current = () => { void flushHead(); }`). The seam is: `flushHead` is declared AFTER `sendText` so it closes over it — the same ordering constraint carries into the hook split: `usePromptQueueFlusher`'s `flushHead` closes over `sendText`, so the flusher hook must RECEIVE `sendText` (or the dispatch hook must be called first and its `sendText` passed down).
- `draftRef` is needed by `send` (stale-draft guard) and by the restore — both dispatch-side; the flusher does not read it (the Flush has no composer). So `draftRef` is dispatch-only, but the planner should thread it explicitly since `useChatAttachments` also takes it as an argument (a shared handle the component owns).
- `attachmentsRef` / `moveOutForSend` / `restoreHeldForSend` / `releaseHeldForSend` / `clearStaged` — dispatch-side only (§2). `flushHead`'s URL release (`entry.attachments.forEach(releaseAttachment)`) touches the QUEUE ENTRY's copy, not the hook's held map — it does not need `useChatAttachments` functions, but it DOES need `releaseAttachment` (still imported in `ChatStream.tsx` line 14).

The `useSessionIdleEdge` call itself stays in `ChatStream`'s unconditional block (it is a hook; it must remain above the early return). The `onIdle: () => flushRef.current()` wiring stays in `ChatStream` — the ref is assigned by the flusher hook's body. Task04 must keep this split: the edge HOOK stays in the component, the `flushHead` BODY moves into `usePromptQueueFlusher`, and the ref assignment `flushRef.current = () => { void flushHead(); }` moves with the flush body (it can live inside the flusher hook, which receives `flushRef` as an argument).

---

## 5. `heldForSendRef` is no longer in `ChatStream.tsx` — CONFIRMED

`grep -n "heldForSendRef" src/components/ChatStream.tsx` returns exactly ONE hit — line 678, which is inside a COMMENT (`// NOTE: no `turnCompleted` here. The success path releases `heldForSendRef`…`). There is **no declaration, no read, no write** of the map in the component. The map now lives inside `useChatAttachments.ts` (declared line 162, read/written lines 178, 409, 440, 484, 502, 505).

**Task04 must not try to move `heldForSendRef` again** — it does not exist in `ChatStream.tsx` to move. Task04 consumes `useChatAttachments`'s functions instead: `moveOutForSend`, `restoreHeldForSend`, `releaseHeldForSend`, `clearStaged`, `clearAll`, plus the `attachmentsRef` it returns. A plan that says "extract `heldForSendRef` out of `ChatStream.tsx` into `useChatPromptDispatch`" is writing against the pre-wave-2 tree — the correct wording is "thread `useChatAttachments`'s returned boundary functions into `useChatPromptDispatch` as arguments."

---

## 6. What `ChatStream.test.tsx` holds now (7140 lines, 244 tests) — and the `sendRelay` precedent

`wc -l src/components/ChatStream.test.tsx` = **7140**. Total tests = **244** = 241 `it(` + 3 `it.each` rows (the single `it.each` at line 3205 has 3 rows; there are no `it.skip`/`it.todo`). This matches the dispatcher's claim exactly.

### The attachment-free `describe` blocks — current start lines and test counts

| Start line | `describe` title | `it(` count |
|---|---|---|
| 230 | `ChatStream` | 149 |
| 3716 | `ChatStream — out-of-Space Directory completion (ADR 0035)` | 34 |
| 5325 | `ChatStream (a child gate renders inline in the PARENT's transcript)` | 13 |
| 5665 | `ChatStream (a child gate scrolls into view)` | 3 |
| 5835 | `ChatStream — the /compact Composer command (ADR 0044)` | 7 |
| 5966 | `ChatStream — the [image #N] staging marker` | 6 |
| 6135 | `ChatStream — the failed-send attachment restore` | 1 |
| 6223 | `ChatStream — send() forks to the prompt queue while the composer is locked` | 9 |
| 6444 | `ChatStream — the Flush: the queue drains when the Session goes idle` | 13 |
| 6947 | `ChatStream — staging attachments is allowed while a turn is in flight` | 4 |
| 7075 | `ChatStream — the empty-state film beside a non-empty prompt queue` | 2 |

(The 241 sum is per top-level `describe`, with the nested `describe` at 5116 inside the out-of-Space block counted within its 34; the 3 `it.each` rows are inside that same 34, at lines 3205–3220.)

### The groups task04 will move

- **The `/compact` group** — `describe("ChatStream — the /compact Composer command (ADR 0044)", ...)` at **5835**, 7 tests. Its titles: `"the / picker lists the command with its description, and never a skill"`, `"selecting the command row inserts `/compact ` (selectMention's existing fall-through)"`, `"/compact dispatches compact_session with null instructions and sends nothing"`, `"/compact <args> reaches compact_session as the instructions"`, `"a non-live answer (false) adds ONE system-style line with its own messageId"`, `"/compact on a RESUMABLE stored session does not resume it (ADR 0044)"`, `"an unmatched /name sends BYTE-IDENTICALLY (the File-completion insert fall-through)"`. These pin `send`'s command intercept (ADR 0044) — they move with `send` into `useChatPromptDispatch`'s test file.
- **The "send() forks to the prompt queue while the composer is locked" group** — `describe(...)` at **6223**, 9 tests. Its own local helpers `composerValue` (6225), `composerThumbs` (6230), `queue` (6237), `png` (6247). Titles include `"Enter while inTurn queues the draft instead of sending it"`, `"queues a mention-bearing draft RAW (expansion runs at send, per ADR 0069)"`, `"an empty draft while locked stays a silent no-op (nothing to queue)"`, `"a marker-only draft with no attachments while locked queues nothing"`, `"a Composer command while locked is NOT queued — it answers with a line"`, `"a locked send MOVES the staged attachment into the entry (no revoke, empty strip)"`, `"a locked send queues on the `blocked` and `compacting` locks too (all three lock sources)"`, `"the turn ending FLUSHES the queue (the busy→idle edge is the Flush's trigger)"`, `"an unlocked send still dispatches and queues nothing (the regression pin)"`.
- **The "Flush: the queue drains when the Session goes idle" group** — `describe(...)` at **6444**, 13 tests. Its own local helpers `queue` (6446), `enqueue` (6451), `queuedAttachment` (6467), `runTurnAndSettle` (6480). Titles include `"a busy→idle fall sends the queue head as an ordinary prompt"`, `"the Flush runs `sendText`, so a queued Mention expands at send (not at enqueue)"`, `"one settle sends ONE entry and the next settle sends the next (queue order)"`, `"a failed Flush puts the entry back at the head marked `failed` and sends EXACTLY once"`, `"saving an edit of the failed entry makes it flushable again"`, `"a prompt queued during an IDLE compaction flushes when the compaction ends"`, `"a successful Flush RELEASES its attachment's object URL"`, `"a Flush to an agent that cannot take images sends TEXT-ONLY (fail-closed)"`, `"renders with no active session without crashing, and still flushes once one appears"`, `"a Session switch away from a BUSY session does NOT flush the arrived-at Session's queue"`, `"a Flush whose attachment READ fails settles NO turn and keeps the previous stop reason"`, `"the stack renders between the transcript island and the composer island"`, `"renders no queue-rows element at all when the queue is empty"`.

**What STAYS in `ChatStream.test.tsx` (integration — do NOT move with the dispatch hooks):** the capability-provenance pin `"paste stages a thumbnail in a resumable stored session (capability read from the stored session)"` (line ~970s), the `+`-button enablement trio + picker hand-off, `"switching sessions clears staged attachments"` (session-switch effect wiring — `prevSessionIdRef` + `clearAll`/`releaseHeldForSend`), the full-send image tests `"send delivers images with the prompt"` (1516), `"staged thumbnails leave the composer AT SEND, not when the send resolves"` (1556), `"switching sessions while a send is in flight releases the LEFT session's held attachment"` (1603), the capability-regression send tests (1661 `"an image-only send is blocked when the capability regresses mid-session…"`, 1685 `"image-only send is allowed"`, 1745 `"send is fail-closed without the capability"`, 1768 `"send is aborted if the session switches during the read"`, 1815 `"an image removed during the read is not sent"`, 1839, 1870 `"a draft edited during the read is not sent and is not wiped"`), the resume-capability pins (2010, 2041), `"double-send is guarded by sendingRef"` (1715 — THE one-Set pin; it drives the REAL component, two synchronous clicks before the FileReader await), the `#`-collision/mask feed-forward pins (in the marker describe 5966–6134), the failed-send end-to-end `"a failed send renumbers the draft when it re-prepends the held attachments"` (in the 6135 describe), the staging-while-in-flight group (6947), and the empty-state-film group (7075). These prove the dispatch hooks' wiring THROUGH the real `ChatStream`, and several (switching-sessions, double-send) are precisely the integration that the two-hook split must keep green.

### The `sendRelay` precedent for driving a dispatch hook without the full component

`src/hooks/useChatAttachments.test.tsx` invented the `sendRelay` pattern (lines 313–344): a minimal `send()` call-alike that drives the hook's boundary functions in `send`'s real order — (1) `setDraft("")` (the `onCommitted` FIRST statement), (2) `moveOutForSend` (the held move), (3) await the mocked IPC, (4) `restoreHeldForSend` on rejection. Its signature:

```ts
function sendRelay(
  api: UseChatAttachmentsResult,
  deps: {
    draftRef: RefObject<string>;
    setDraft: (value: string) => void;
    setError: (value: string | null) => void;
  },
): void {
  const sessionId = "s1";
  deps.setDraft("");                                     // 1. onCommitted's FIRST statement
  const staged = api.attachmentsRef.current;
  api.moveOutForSend(sessionId, new Set(staged.map((a) => a.id))); // 2. the held move
  void sendPrompt(sessionId, deps.draftRef.current, undefined).catch(
    (err: unknown) => {
      api.restoreHeldForSend(                             // 4. the catch
        sessionId,
        err instanceof Error ? err.message : String(err),
        deps.setError,
        deps.setDraft,
      );
    },
  );
}
```

**How it wires `draftRef`/`setDraft`/`setError`:** the `Harness` component (lines 216–280) owns the draft, error and composer cells; it declares `const [draft, setDraft] = useState("")`, `const [error, setError] = useState<string | null>(null)`, `const draftRef = useRef(draft); draftRef.current = draft;`, and hands the hook `setDraft, setError, draftRef, activeSessionIdRef, composerRef` — exactly the six args `ChatStream` passes. It captures `const relayDeps = { draftRef, setDraft, setError };` and a `<button onClick={() => sendRelay(api, relayDeps)}>Send</button>`. The relay reads the draft LIVE through `deps.draftRef.current` (never `api.attachmentsRef`, which is the attachment list and was just emptied by the move). **This is the exact precedent task04's `useChatPromptDispatch.test.ts` should follow**: a host harness that reproduces `ChatStream`'s refs/setters, calls the real dispatch hook, and drives it through a button instead of the whole component — with the same "the draft/setDraft/setError are the harness's own, the hook owns none of them" split.

---

## 7. Gate numbers to reconcile against

- Baseline (post-wave-1, `27cec040`): **160 files, 3353 passed | 1 skipped**.
- **Now (post-wave-2, code `0aa99ffb`): 161 files, 3354 passed | 1 skipped** — the status file's wave-2 changelog records the orchestrator's own re-run: `pnpm test` → **161 files, 3354 passed | 1 skipped**, exit 0; `pnpm build` → exit 0. Arithmetic reconciles exactly: 3353 − 34 moved (out of `ChatStream.test.tsx`) + 35 in the new `useChatAttachments.test.tsx` (34 moved + 1 NEW surface-pin) = **3354**.
- `ChatStream.test.tsx` alone → **244** (278 − 34 moved; verified statically: 241 `it(` + 3 `it.each` rows).
- `useChatAttachments.test.tsx` alone → **35** (18 in the paste/staging/remove describe incl. the surface pin + 4 held-boundary + 12 marker + 1 failed-restore).

**The tauri-barrel mock-seam pin** — `src/lib/tauriBarrel.test.ts`, `it("the scanner sees the mock seam it exists to protect")` at line 398. It is a SET-SIZE assertion, and wave 2 moved it **by exactly one mocker + one spreader**: the set grew 38 → 39 (line 424 `expect(mockers).toHaveLength(39)`) and the `vi.importActual`-spreaders grew 37 → 38 (line 432 `expect(...).toBe(38)`). The provenance comment now records `38 -> 39 when the chatstream decomposition moved `ChatStream`'s attachment tests into `src/hooks/useChatAttachments.test.tsx`, which mocks the barrel the documented way` (the diff shows the comment grew by exactly that clause). **Do not restate 38/39 as anything to maintain** — the number may only move when a test file is added/removed; task04's new hook test files will mock the barrel by module path with `importActual`-spreading factories, so the pin grows again (see §8 trap (b)) and the implementer reads the current values off the file and bumps both in the same commit, extending the provenance comment to name the new file.

---

## 8. The two live traps, restated with current evidence

**(a) The hook-ordering / early-return rule — now anchored by TWO extracted hooks.** Every hook must be called in the unconditional block ABOVE the `if (!activeSessionId)` early return at line 509, or the app white-screens with "Rendered more hooks than during the previous render". The block now holds `useChatSessionDerivations()` (86–94) AND `useChatAttachments()` (279–298), plus `useHasPendingRequest`, `useChildGates`, `useSpinQuip`, `useActiveSpaceCwd`, `useMentionCatalogs`, `useCompletionDir`, `useMentionPicker`, `useWindowDropBackstop`, `useAutoGrowComposer`, and `useSessionIdleEdge` (503–507) — the last hook before the early return. **Task04's two new dispatch hooks are hooks (they contain `useRef`/`useEffect`/`useState`), so BOTH must be called in this unconditional block, above the early return** — not "next to `sendText`" (which lives BELOW the return). The task03 header comment is the standing evidence: `ChatStream.tsx` 267–269 ("The draft, its live ref, the error line, the composer ref and the two capability gates are ARGUMENTS: the hook owns none of them") and the `useChatAttachments` call is itself placed "directly after the `draftRef.current = draft;` re-sync" — the new hooks must land in the same region, and the `sendRelay`/harness pattern (§6) is how their tests drive them without the component.

**(b) The `vi.mock` probe matrix appendix** — `docs/roadmap/chatstream-decomposition-ground-chat-test-scaffolding.md`, lines 550–565. The rule: a `vi.mock` factory may reference only bindings whose module is BOTH free of any transitive import of the mocked specifier AND imported before anything that imports it; violating either fails as **0 tests run** with `Cannot access '__vi_import_N__' before initialization`. **Task04's new test files WILL mock the barrel** (`useChatPromptDispatch.test.ts`/`usePromptQueueFlusher.test.ts` drive `sendText` → `sendPrompt`, `resumeSession`, `compactSession`, the attachment read, the mention catalogs — the same seam the wave-2 factory mocks), so:
- the pin at `tauriBarrel.test.ts` grows again (both counts) in the SAME commit as each new test file, with the provenance comment extended to name it; and
- **the factories must stay INLINE** — `src/test/chatStreamFixtures.ts` imports `useSessions`/`useSettings`, whose stores import `../lib/tauri`, so it HAS a transitive path into the mocked barrel; delegating the factories to it fails as 0 tests run. The winning shape is exactly what `useChatAttachments.test.tsx` does (lines 96–183): the tauri factory body references ONLY `vi` and its local `actual` (`await vi.importActual<Record<string, unknown>>("../lib/tauri")`), the dialog factory only `vi`. Keep that shape.

---

## Verification notes / flags

- All line numbers re-measured at `77cb4f1a` / code `0aa99ffb`. The seam-body "identical" verdicts (§4) are `sed`-extraction `diff` comparisons against `git show 27cec040:...` — `sendText` and `flushHead` IDENTICAL, `resume` IDENTICAL, `send` differs only in the 4 re-points + the fork-comment tweak.
- `ChatStream.test.tsx` = 7140 lines (`wc -l`), down from 7673 (post-wave-1) — the 34 moved tests + the moved marker-describe `composerValue` helper left it. `useChatAttachments.test.tsx` = 947 lines.
- A full `vitest` run is NOT re-executed here (a 180s timeboxed run timed out before producing a summary); the 244/35/3354 numbers are reconciled from static `it(`/`it.each` counts and the status file's recorded orchestrator re-run at `0aa99ffb`, and they match the dispatcher's claimed gates exactly. Nothing contradicts the measurements.
- `src/components/ChatStream.tsx` still imports `releaseAttachment` (line 14) — used by `flushHead`'s queue-entry release at line 1002 (`entry.attachments.forEach(releaseAttachment)`), NOT by the held map (which is inside the hook). Task04 keeps `releaseAttachment` for the flush path.
- The `git diff --stat 27cec040..HEAD` for the two test files: `ChatStream.test.tsx` −573/+... and `useChatAttachments.test.tsx` +947 — consistent with the 34-test move + surface pin + the `stageFiles`-driven describes leaving the component file.
