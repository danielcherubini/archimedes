---
status: committed
parent: docs/roadmap/chatstream-decomposition-status.md
done-when: >
  (1) `src/hooks/useChatAttachments.ts` + `src/hooks/useChatAttachments.test.tsx`
  exist and the hook returns exactly the pinned surface (12 names:
  `attachments`, `attachmentsRef`, `stageFiles`, `handlePaste`, `handleDrop`,
  `handleAttachClick`, `removeAttachment`, `moveOutForSend`,
  `restoreHeldForSend`, `releaseHeldForSend`, `clearAll`,
  `clearStaged`);
  (2) `ChatStream.tsx` calls the hook ONCE in the unconditional block above the
  `if (!activeSessionId)` early return (directly after the `draftRef.current = draft;`
  re-sync, near current line 287) and no longer declares the moved
  state/handlers/refs itself — `grep -n "const stageFiles" src/components/ChatStream.tsx`
  returns NOTHING; (3) the attachment-focused test groups have MOVED into
  `src/hooks/useChatAttachments.test.tsx` and still assert the WebKitGTK
  empty-paste clipboard fallback (the six pins, all moved) and the failed-send
  restore contract (`"a failed send keeps attachments staged"`,
  `"a failed send restores the thumbnail WITHOUT releasing its object URL"`,
  `"unmounting while a send is in flight releases the held attachment"`,
  `"a failed send restores at most MAX_CHAT_ATTACHMENTS and releases the overflow"` —
  the renumber/prepend end-to-end and session-switch-held-restore stay in
  `ChatStream.test.tsx` as integration); (4) the `[image #N]`/mask feed-forward
  tests and the queue/Flush/staging-while-in-flight integration attachment tests
  stay in `ChatStream.test.tsx`; (5) the tauri mock-seam assertion at
  `src/lib/tauriBarrel.test.ts` `it("the scanner sees the mock seam it exists to
  protect")` was bumped by +1 (both counts, to the values it then reads) and its
  provenance comment extended to NAME `src/hooks/useChatAttachments.test.tsx`
  (the new file mocks the barrel the documented module-path +
  `vi.importActual`-spreading way); (6) the queue-fork's staged-clear uses the
  hook's non-revoking `clearStaged()` (the ADR-0069 "never revoke here" move —
  `URL.revokeObjectURL` is NOT called there; the old `setAttachments([])` direct
  call is gone from `ChatStream.tsx`); (7) the full gate is green from the repo
  root — `pnpm test` (all pass) and `pnpm build` (exit 0), and the exact
  per-file commands in the plan pass individually. Nothing outside the plan's
  Owns set (`src/hooks/useChatAttachments.ts`, `src/hooks/useChatAttachments.test.tsx`,
  `src/components/ChatStream.tsx`, `src/components/ChatStream.test.tsx`,
  `src/lib/tauriBarrel.test.ts`) changed in this task.
---

# Task 03 — `useChatAttachments` — Attachment Lifecycle & Staging (issue #135 §1)

**Goal:** Move the attachment lifecycle out of `ChatStream.tsx` — `stageFiles`, `handlePaste`, `handleDrop`,
`handleAttachClick`, `removeAttachment`, the `attachments` state + `attachmentsRef`, the `heldForSendRef`
failed-send map, and the `[image #N]` marker insert/renumber those handlers perform — into a single hook, and
move the attachment-focused test groups out of `ChatStream.test.tsx` alongside it. Behaviour is MOVED, not
improved; nothing outside the Owns set changes.

**Architecture:** `useChatAttachments` is a stateful hook that OWNS the composer's staged attachments
(`useState` + the live `attachmentsRef`) and the held-for-send map (`heldForSendRef`), returns the handlers
`ChatStream` already threads into `ComposerRow`, and additionally exposes THREE boundary operations the
dispatch seam and the session-switch effect call on the held map (`moveOutForSend`, `restoreHeldForSend`,
`releaseHeldForSend`) plus two staged-list clears (`clearAll` — the session-switch release-open clear, and
`clearStaged` — the queue-fork's non-revoking "URLs MOVE with the text" clear). The hook OWNS neither `draft` nor
`setDraft` (`stageFiles` and `removeAttachment` write the marker text into the caller's draft; `send`
writes it too — the wipe at send and the failed-send shift — so no hook can own it; the house precedent is
`useMentionPicker`, whose own comment says the hook never owns the draft). The hook reads the live draft
through the caller's `draftRef` argument, never through a render closure — the current behaviour, preserved.
`imageCapable`/`composerEnabled` (both now supplied by `useChatSessionDerivations()` after wave 1) and
`activeSessionIdRef` are arguments.

**Tech Stack:** React hooks + the existing pure layer `src/lib/chatAttachments.ts`; vitest 5.x; pnpm. No new
dependencies.

---

## Parallelisation

**Verdict:** SERIAL — this task edits `src/components/ChatStream.tsx` and
`src/components/ChatStream.test.tsx`, which every other decomposition task also edits, so it shares a file
with every sibling task and has no disjoint file set. Parallelism in this roadmap lives BETWEEN tasks (the
wave grouping the status file owns); it never exists inside one task. (Wave 2 is width 1 and runs unisolated
in the primary tree, per the status file's isolation decisions.) This plan emits no `**Parallel:**` line.

---

### Task 03: Extract the attachment lifecycle into `useChatAttachments`

**Context:**

`ChatStream.tsx` (1,488 lines at HEAD `27cec040`, the post-wave-1 tree) still declares the attachment
lifecycle inline: the `attachments`/`setAttachments` state, the `attachmentsRef` live mirror, the
`heldForSendRef` failed-send map, the five handlers (`stageFiles`, `handlePaste`, `handleDrop`,
`handleAttachClick`, `removeAttachment`), and the `[image #N]`-marker insert/renumbering those handlers
perform. This task extracts all of it into `src/hooks/useChatAttachments.ts`. The boundary is consumed by
wave 3 (`C1`, the dispatch/queue/flush extraction), so this task fixes it explicitly.

Two measured constraints from wave 1 (post-wave-1 delta, §§1/6) dominate the design:

1. **`imageCapable`/`composerEnabled` changed provenance in wave 1.** They are no longer component-locals
   derived from an `activeCapabilities` selector — that selector and the `sessionFieldOf` import are GONE
   from `ChatStream.tsx` (grep counts 0; wave 1's task01 moved them into `useChatSessionDerivations`). The
   current destructure (lines 96–105), which the hook must RECEIVE its gates from, reads:

   ```tsx
   const {
     askRequests,
     confirmRequests,
     passwordRequests,
     stackedAskRequests,
     isLive,
     canResume,
     composerEnabled,
     turnDiffs,
     imageCapable,
   } = useChatSessionDerivations();
   ```

   The hook cannot recompute `imageCapable` itself (the capabilities live only inside
   `useChatSessionDerivations`), so it takes VALUES, not stores — the "must receive them as arguments"
   shape the report demands.

2. **The hook-ordering / early-return rule is unchanged and now coexists with one extracted hook.** Every
   hook must be called in the unconditional block above the `if (!activeSessionId)` early return (line 516)
   or the app white-screens with "Rendered more hooks than during the previous render".
   `useChatSessionDerivations()` already sits in that block (96–105); the attachment hook joins it.
   The attachment hook's own `useState`/`useRef`/`useEffect` run on the no-session path too — exactly as the
   current `attachments` state, `attachmentsRef`, `heldForSendRef` and the unmount effect already do (they
   all live above the early return today).

All anchors are by SYMBOL, not line number (lines are locators at HEAD `27cec040`). Read the two grounding
reports before implementing: `docs/roadmap/chatstream-decomposition-ground-attachment-lib.md` (the handler
bodies, the URL contract, the held-map contract, hook house style) and
`docs/roadmap/chatstream-decomposition-ground-post-wave1.md` (the wave-1 delta — which component-locals no
longer exist).

**Files:**
- Create: `src/hooks/useChatAttachments.ts`
- Create (Test): `src/hooks/useChatAttachments.test.tsx`
- Modify: `src/components/ChatStream.tsx`
- Modify (Test): `src/components/ChatStream.test.tsx`
- Modify (Test, pin update only): `src/lib/tauriBarrel.test.ts`

**What to implement:**

### A. `src/hooks/useChatAttachments.ts` (new)

Imports:

```ts
import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent, RefObject } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readClipboardImage, readFileBytes } from "../lib/tauri";
import { basenameOfPath } from "../lib/paths";
import { describeIpcError } from "../lib/ipcError";
import {
  addImageAttachments,
  imageMarker,
  insertAtCaret,
  MAX_CHAT_ATTACHMENTS,
  releaseAttachment,
  renumberImageMarkers,
  shiftImageMarkers,
  type ChatComposerAttachment,
} from "../lib/chatAttachments";
import {
  inferAttachmentMimeType,
  shouldPreferSpreadsheetClipboardText,
} from "../lib/chatAttachmentMetadata";
```

Header comment (house idiom, §8.2/8.3 of the attachment grounding report): record that the five handlers,
the `attachments` cell and the held map were MOVED VERBATIM out of `ChatStream` (issue #135 §1); that the
hook OWNS the attachments cell + `attachmentsRef` + `heldForSendRef` but NEITHER the draft (eleven sites
write it — the `useMentionPicker` precedent) NOR the composer ref; that `stageFiles`/`removeAttachment`
write the caller's draft through its `draftRef`/`setDraft` arguments; and the held-map boundary contract from
§5.3 of the attachment report (keyed by session id; restore respects `MAX_CHAT_ATTACHMENTS`, dedupes by
`id`, prepends, releases the overflow, shifts the draft's markers by the number ACTUALLY restored, and must
run in ONE synchronous block with `setError`).

```ts
export interface UseChatAttachmentsArgs {
  setDraft: (value: string) => void;
  draftRef: RefObject<string>;
  activeSessionIdRef: RefObject<string | null>;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  imageCapable: boolean;
  composerEnabled: boolean;
}
```

(No `draft` value argument — the hook reads the live draft exclusively through `args.draftRef`, exactly as
`stageFiles`/`removeAttachment` do today. The setter + the ref are the two handles those handlers use.)

```ts
export interface UseChatAttachmentsResult {
  /** The staged attachments — the strip renders from this state (moved verbatim). */
  attachments: ChatComposerAttachment[];
  /** The LIVE mirror of `attachments`, re-synced every render. Send's mid-async
   * reads (`liveIds` reconcile, the held move, the restore's merged list) use
   * this ref exactly as they did in `ChatStream`. */
  attachmentsRef: RefObject<ChatComposerAttachment[]>;
  stageFiles: (files: File[]) => void;
  handlePaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  handleDrop: (e: DragEvent) => void;
  handleAttachClick: () => Promise<void>;
  removeAttachment: (id: string) => void;
  /**
   * `send`'s `onCommitted`: move the SENT subset out of the live list into the
   * held map — the thumbnails leave the composer AT send, held not released
   * (a failed send puts them back). The caller already guards
   * `sentIds.size > 0 && activeSessionIdRef.current === targetSessionId`.
   */
  moveOutForSend: (targetSessionId: string, sentIds: Set<string>) => void;
  /**
   * `send`'s catch: restore the held list IN FRONT of whatever is staged now,
   * respecting `MAX_CHAT_ATTACHMENTS`, deduping by `id`, releasing the overflow,
   * shifting the draft's marker numbers by the number ACTUALLY restored, and
   * landing the error line in the SAME synchronous block (React 19 batching —
   * see the contract comment that moves verbatim with this block). The CALLER
   * calls this UNCONDITIONALLY after the catch's settle; the hook re-checks
   * `activeSessionIdRef.current === targetSessionId` internally for both the
   * restore and the error line, and always runs the map delete (a no-op once
   * the session-switch effect already released the entry).
   *
   * The `if (back.length > 0) { setDraft(shiftImageMarkers(...)) }` guard moves
   * VERBATIM: the shift runs ONLY inside the same `held && held.length > 0 &&
   * activeSessionIdRef.current === targetSessionId` block, exactly as in
   * `send()`'s catch at `ChatStream.tsx:969` — it never runs when nothing was
   * actually restored (`shiftImageMarkers` itself documents `by === 0` as a
   * no-op, `src/lib/chatAttachments.ts:299-301`). This is a MOVE, not an
   * improvement: do NOT hoist the shift out of the guard.
   */
  restoreHeldForSend: (
    targetSessionId: string,
    errorMsg: string,
    setError: (value: string | null) => void,
    setDraft: (value: string) => void,
  ) => void;
  /**
   * Release the held list for a session and drop its map entry (the send
   * SUCCESS path, and the session-switch / unmount cleanups). Never touches the
   * live list — the success path's composer is already clean, and the
   * session-switch path clears the staged list through `clearAll()` separately.
   */
  releaseHeldForSend: (targetSessionId: string) => void;
  /** Session switch: clear + release the STAGED list (the fail-closed guard —
   * the images staged in the session being LEFT must not leak into the next). */
  clearAll: () => void;
  /**
   * The ADR-0069 queue-fork's staged clear: empty the staged list (ref + state)
   * WITHOUT releasing the object URLs — the URLs MOVE with the text into the
   * queue entry (`QueuedPrompt.attachments` owns them from there; revoking
   * here would blank the queue row's preview and the later send). The caller
   * (`send`'s locked fork) reads `attachmentsRef.current` into the entry FIRST,
   * then calls this. The "who may revoke" rule therefore stays inside the hook:
   * no caller is handed the raw `setAttachments`.
   */
  clearStaged: () => void;
}
```

Body:

```ts
export function useChatAttachments(args: UseChatAttachmentsArgs): UseChatAttachmentsResult {
  const [attachments, setAttachments] = useState<ChatComposerAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  /** Attachments handed to a send that has not settled yet, keyed by session id.
   * They are OUT of `attachments` (so their thumbnails leave the composer
   * immediately) but NOT released — a failed send puts them back. */
  const heldForSendRef = useRef<Map<string, ChatComposerAttachment[]>>(new Map());
  // Re-sync every render: the handlers read the CURRENT list from the ref
  // (a render closure would be stale for fast successive events — e.g.
  // pasting 8 files then a 9th in separate dispatches without a re-render
  // in between). Also read by the unmount-cleanup effect below.
  attachmentsRef.current = attachments;
  // Unmount cleanup: revoke the staged object URLs exactly once, on unmount
  // ONLY — revoking on every state change would leak/break live previews (a
  // revoked URL can no longer render the `img`). The held-for-send map is
  // walked too: an unmount while a turn is in flight leaves those attachments
  // in NO state the composer can reach again, so this is their last chance.
  useEffect(
    () => () => {
      attachmentsRef.current.forEach(releaseAttachment);
      heldForSendRef.current.forEach((held) => held.forEach(releaseAttachment));
    },
    [],
  );
```

Then the five handlers, moved VERBATIM from `ChatStream.tsx` lines 1156–1385 (all comments included), with
only these identifier substitutions:

| free variable in `ChatStream.tsx` | replacement in the hook |
|---|---|
| `attachmentsRef` / `setAttachments` | the hook's own `attachmentsRef` / `setAttachments` |
| `draftRef` | `args.draftRef` |
| `setDraft` | `args.setDraft` |
| `composerRef` | `args.composerRef` |
| `imageCapable` | `args.imageCapable` |
| `composerEnabled` | `args.composerEnabled` |
| `activeSessionIdRef` | `args.activeSessionIdRef` |

The bodies stay byte-identical apart from those substitutions. Load-bearing details that must move verbatim:
the WebKitGTK empty-paste fallback (`files.length === 0 && !text` trigger, the `pastedInSession` guard read
from `args.activeSessionIdRef`, the silent `.catch` — no error line), the caret rule ("CARET ONLY WHEN THE
TEXTAREA ACTUALLY HAS FOCUS"), the whole-batch single insert with the count from the RETURNED list,
`handleDrop`'s doc comment, the `composerEnabled`-stays / `composerLocked`-absent note on
`handleAttachClick`, and `removeAttachment`'s revoke-outside-the-updater + `findIndex + 1` position
contract.

```tsx
  const { draftRef, setDraft, composerRef, imageCapable, composerEnabled, activeSessionIdRef } = args;

  const stageFiles = (files: File[]) => { /* moved verbatim, identifiers substituted */ };
  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => { /* moved verbatim */ };
  const handleDrop = (e: DragEvent) => { /* moved verbatim */ };
  const handleAttachClick = async () => { /* moved verbatim */ };
  const removeAttachment = (id: string) => { /* moved verbatim */ };
```

Then the five boundary operations:

```ts
  // /// ── The held-for-send boundary (wave 3's seam) ─────────────────────────
  function moveOutForSend(targetSessionId: string, sentIds: Set<string>): void {
    const held = attachmentsRef.current.filter((a) => sentIds.has(a.id));
    heldForSendRef.current.set(targetSessionId, held);
    const staged = attachmentsRef.current.filter((a) => !sentIds.has(a.id));
    attachmentsRef.current = staged;
    setAttachments(staged);
  }

  // The failed-send restore. VERBATIM semantics of `send`'s catch block (the
  // comment block above it — the batching contract, the cap, the dedupe, the
  // release of the overflow, the marker shift — moves with it). `errorMsg` is
  // the ALREADY-formatted message; `setError`/`setDraft` are the CALLER's
  // setters, landed in this one synchronous call so the restore, the shift and
  // the error line stay in one React 19 batch, exactly as today.
  function restoreHeldForSend(
    targetSessionId: string,
    errorMsg: string,
    setError: (value: string | null) => void,
    setDraft: (value: string) => void,
  ): void {
    const held = heldForSendRef.current.get(targetSessionId);
    if (held && held.length > 0 && activeSessionIdRef.current === targetSessionId) {
      // ...the verbatim restore block from ChatStream.tsx send()'s catch
      // (`live`, `ids`, `fitting`, `room`, `back`, the overflow release,
      // `merged`, `attachmentsRef.current = merged`, `setAttachments(merged)`,
      // and the `if (back.length > 0) { setDraft(shiftImageMarkers(draftRef.current,
      // back.length)); }` write) — the shift guard stays INSIDE this block,
      // byte-identical to line 969. The setError below is NOT moved inside this
      // block: both state updates land in one synchronous call, which is the
      // React 19 batching contract the moved comment above documents...
    }
    heldForSendRef.current.delete(targetSessionId);
    // The setError guard mirrors send()'s catch EXACTLY: the error line only
    // when this is still the send's session. The caller calls this
    // UNCONDITIONALLY after the catch's settle — the delete must always run
    // (a no-op once the session-switch effect already released the entry) and
    // the restore + error line stay in this one synchronous call (the React 19
    // batching contract the comment block above documents).
    if (activeSessionIdRef.current === targetSessionId) {
      setError(errorMsg);
    }
  }

  function releaseHeldForSend(targetSessionId: string): void {
    const held = heldForSendRef.current.get(targetSessionId);
    if (held) {
      held.forEach(releaseAttachment);
      heldForSendRef.current.delete(targetSessionId);
    }
  }

  function clearAll(): void {
    attachmentsRef.current.forEach(releaseAttachment);
    attachmentsRef.current = [];
    setAttachments([]);
  }

  function clearStaged(): void {
    // The ADR-0069 queue move: the URLs leave with the text, so NOTHING is
    // released here (releaseAttachment is deliberately NOT called). This is the
    // only surface name that can empty the staged list besides `clearAll`, and
    // it is the ONLY one that does so without revoking — a caller that needs
    // the revoke uses `clearAll`, never the raw setter.
    attachmentsRef.current = [];
    setAttachments([]);
  }

  return {
    attachments,
    attachmentsRef,
    stageFiles,
    handlePaste,
    handleDrop,
    handleAttachClick,
    removeAttachment,
    moveOutForSend,
    restoreHeldForSend,
    releaseHeldForSend,
    clearAll,
    clearStaged,
  };
}
```

**Decision record — constraint #5 (`heldForSendRef` ownership), which wave 3 consumes:** the hook OWNS
`heldForSendRef` and does NOT return it. It exposes the operations wave 3's `send`/`flushHead` already
perform on it: `moveOutForSend` (the `onCommitted` held move), `restoreHeldForSend` (the catch, landing
`setError` in the same synchronous block), `releaseHeldForSend` (the success path and the session-switch /
unmount cleanups), plus `clearAll` (the session-switch staged clear), `clearStaged` (the queue-fork's
non-revoking staged clear) and the `attachmentsRef` itself (returned — `send` reads the LIVE list
mid-async in three places: the `liveIds` reconcile, the held move's filter, and the restore's merged-list).
This is the "it owns it and exposes restore functions" arm of the choice, chosen because every current
`heldForSendRef.current.*` call site (the five in `send`, the session-switch effect, the unmount effect) is
wrapped by one of these operations — returning the raw map would hand wave 3 a second path to mutate the
same state. Wave 3's exact call sites are specified in §B5.

**The identifier-substitution proof the vet will check:** the ONLY edits to the five handler bodies and the
restore block are the table's substitutions; the WebKitGTK fallback, the caret rule, the revoke order, and
the failed-restore "never revoke here" site are text-identical. A diff of the extracted span against
`git show 27cec040:src/components/ChatStream.tsx` will show no hunks outside the substitutions. The ONE
deliberate exception is the ADR-0069 queue-move's clear (§B3): its two direct writes
(`attachmentsRef.current = []; setAttachments([]);`) become the single `clearStaged()` call — that is a
re-point to the hook's boundary (the "who may revoke" rule moves inside the hook), not a behaviour change
(it still releases nothing). It is the ONLY hunk outside the extracted span in the whole diff.

### B. `src/components/ChatStream.tsx` (modify)

**B1. Add the hook call** (one line family) in the unconditional block, DIRECTLY AFTER the
`draftRef.current = draft;` re-sync (near current line 287) — that is the point where `draft`, `setDraft`,
`composerRef`, `activeSessionIdRef` and `draftRef` all exist, and it is still well above the
`if (!activeSessionId)` early return at line 516. It sits in the same unconditional block as the
`useChatSessionDerivations()` destructure (96–105); the hook-count rule requires only "above the early
return", not a specific sibling position. (A call placed after the early return — e.g. "next to the
handlers" — is a white-screen bug; the status file's post-wave-1 report names this trap explicitly.)

```tsx
  const {
    attachments,
    attachmentsRef,
    stageFiles,
    handlePaste,
    handleDrop,
    handleAttachClick,
    removeAttachment,
    moveOutForSend,
    restoreHeldForSend,
    releaseHeldForSend,
    clearAll,
    clearStaged,
  } = useChatAttachments({
    setDraft,
    draftRef,
    activeSessionIdRef,
    composerRef,
    imageCapable,
    composerEnabled,
  });
```

**B2. Delete what moved** (each was verified against `27cec040`):

- The attachments state block (lines ~255–266): `const [attachments, setAttachments] = useState<ChatComposerAttachment[]>([]);`, `const attachmentsRef = useRef(attachments);`, `const heldForSendRef = useRef<Map<...>>(new Map());`, and the `attachmentsRef.current = attachments;` re-sync line.
- The unmount-cleanup effect (lines ~292–298) — moved into the hook.
- The five handler declarations + their header comment (lines ~1154–1385).
- The now-dead imports: `readClipboardImage`, `readFileBytes` (from the `../lib/tauri` import),
  `basenameOfPath` (its import line), `inferAttachmentMimeType` + `shouldPreferSpreadsheetClipboardText`
  (their import line), `open as openFileDialog` (its import line), and from `../lib/chatAttachments`:
  `addImageAttachments`, `imageMarker`, `insertAtCaret`, `renumberImageMarkers`.
- KEEP in the `../lib/chatAttachments` import: `agentSupportsImages` (used at line 808 by `send`'s
  fresh-capability check), `draftIsMarkerOnly` (lines 710/816), `MAX_CHAT_ATTACHMENTS` (line 943),
  `shiftImageMarkers` (line 969), `releaseAttachment` (still used by `flushHead` at ~1066 after the
  unmount/session-switch/send uses move into the hook), `readAttachmentAsBase64` (lines 827/1032), and the
  types `ChatComposerAttachment`, `ImageRef`. (`noUnusedLocals` is ON — `pnpm build` catches any mistake
  here; that red build is the check, not a guess.)

**B3. Re-point the call sites that stay** (all inside the Owns set; the hook's returned names replace the
deleted locals; bodies keep their exact logic):

- **`send`'s `onCommitted`** (lines ~879–884): the `setDraft("")` stays first; then

  ```ts
  if (sentIds.size > 0 && activeSessionIdRef.current === targetSessionId) {
    moveOutForSend(targetSessionId, sentIds);
  }
  ```

- **`send`'s success path** (lines ~900–905): replace the `held = heldForSendRef.current.get(...)` +
  `held.forEach(releaseAttachment)` + `delete` with `releaseHeldForSend(targetSessionId);` —
  `turnCompleted(targetSessionId, stopReason)` stays after it.
- **`send`'s catch** (lines ~925–972): replace the `setError(msg)`-then-restore block with

  ```ts
  restoreHeldForSend(targetSessionId, msg, setError, setDraft);
  ```

  The hook's internal restore re-checks `activeSessionIdRef.current === targetSessionId` for the held block
  and for the `setError`, and the `heldForSendRef.current.delete` runs unconditionally — so today's
  behaviours hold exactly: same-session failure restores + shows the error in one React 19 batch (the
  pinned contract), a session switched away mid-send restores nothing and shows NO error, and the delete
  is a no-op once the session-switch effect already released the entry. `turnCompleted(targetSessionId, "end_turn")`
  still runs BEFORE this call in the catch, exactly as today.
- **`send`'s ADR-0069 locked-composer fork** (lines ~736–745): after the entry is enqueued with
  `attachments: moved`, the two direct writes `attachmentsRef.current = []; setAttachments([]);` become a
  single call to the hook's non-revoking clear:

  ```ts
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

  **The contract pin stays intact: `URL.revokeObjectURL` must NOT be called in this fork** (the "never
  revoke here" rule of §6 of the attachment grounding report). `clearStaged` is the non-revoking clear —
  by construction it cannot release. The pin `"a locked send MOVES the staged attachment into the entry
  (no revoke, empty strip)"` and `"an image dropped mid-turn queues WITH the next prompt instead of
  stranding"` (both stay in `ChatStream.test.tsx`) cover exactly this call.
- **The session-switch effect** (lines ~317–355): `prevSessionIdRef` STAYS a component-local `useRef`
  (declared at ~338 and re-synced inside the effect). Its body becomes:

  ```ts
  if (prevSessionIdRef.current === activeSessionId) return;
  const left = prevSessionIdRef.current;
  prevSessionIdRef.current = activeSessionId;
  clearAll();
  if (left !== null) {
    releaseHeldForSend(left);
  }
  ```

  (The clear order is preserved: staged strip cleared+released, then the LEFT session's held entry released
  and dropped — today's "release the held lookup under the left id, before the overwrite" ordering.)
- **`flushHead`** — UNTOUCHED (`entry.attachments.forEach(releaseAttachment)` at ~1066 releases the QUEUE
  ENTRY's copy, not the held map; out of this task's blast radius).
- **`send`'s `liveIds` reconcile** (line ~832) and the `onCommitted` filters — read `attachmentsRef.current`
  as before; the ref is now the hook's returned one (same object the handlers write).

Everything else in `ChatStream.tsx` is untouched: `sendingSessionsRef` and its re-sync line (268–278), the
Esc effect, `useWindowDropBackstop`, `useAutoGrowComposer`, `useMentionPicker`, `draft`/`setDraft`/`error`/
`setError`, `hasImages = attachments.length > 0 && imageCapable`, the `ComposerRow` props (their names are
unchanged — `attachments`, `removeAttachment`, `handlePaste`, `handleDrop`, `handleAttachClick`,
`imageCapable`, `composerEnabled`), `send`/`sendText`/`flushHead`/`resume`, the queue fork (its two direct
`attachmentsRef.current = []` / `setAttachments([])` writes are the one re-point in B3 — nothing else in it
changes), the transcript.

**Cross-check for noUnusedLocals:** after B2/B3, `ChatStream.tsx` retains BOTH `setError` (send, resume,
etc.) and `setDraft` (onCommitted wipe, catch shift now inside the hook call, the queue fork's `setDraft("")`)
— neither becomes unused, and the direct `setAttachments([])` at line 738 (the queue fork) disappears in
favour of `clearStaged()`.

### C. `src/hooks/useChatAttachments.test.tsx` (new) — the MOVED test groups

**The module-scope block** — verbatim from `ChatStream.test.tsx` lines 87–230:

- `beforeAll` installing `URL.createObjectURL` (→ `blob:mock-${file.name}`), `URL.revokeObjectURL`, and the
  three `HTMLElement.prototype` stubs — with the existing "KEPT, and neither is redundancy" comment.
- The tauri `vi.mock("../lib/tauri", async () => { const actual = await vi.importActual(...); return { ...actual, ...overrides } })`
  factory VERBATIM (same overrides and comments, including `readClipboardImage: vi.fn().mockResolvedValue(null)`
  and `readFileBytes: vi.fn().mockResolvedValue(null)`).
- The dialog `vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn().mockResolvedValue(null) }))` factory
  VERBATIM.
- The `beforeEach` block VERBATIM (real timers, `setSidePaneCollapsed(false)`, `localStorage.clear()`, the
  queued-prompt `clearSession` loop, `vi.clearAllMocks()`, `clearSkillCatalogCache()`,
  `clearMentionCatalogsCache()`, `resetStores()`).

Imports for the new file: `render, screen, fireEvent, waitFor, act` from `@testing-library/react`; the vitest
bindings `beforeEach, describe, expect, it, vi, beforeAll`; `useState, useRef` from `react`;
`seedLiveSessionWithImages, seedLiveSession, pasteToComposer, dropOnComposer, flush, deferred` from
`../test/chatStreamFixtures`; `MAX_CHAT_ATTACHMENTS` from `../lib/chatAttachments`;
`readClipboardImage, readFileBytes, sendPrompt, type StopReason` from `../lib/tauri`;
`open as openFilePicker` from `@tauri-apps/plugin-dialog`; `useSessions` from `../store/sessions`;
`resetStores` from `../test/resetStores`; the hook + its types from `./useChatAttachments`.
NO `waitForCatalog` (none of the moved tests use it — the feed-forward tests that do stay in
`ChatStream.test.tsx`).

**Why this file is `.tsx`:** the moved tests render JSX through the harness (`<div
data-testid="composer-island">`, `<textarea>`, `<img>`, `<button>`), and `tsc` REJECTS JSX in a `.ts` file —
measured on this tree (TypeScript 6.0.3): `transpileModule` of `const el = <div …/>` under `fileName:
"probe.ts"` reports `error TS1005: '>' expected`, while the same source under `"probe.tsx"` compiles clean.
The house precedent is `src/hooks/useDragReorder.test.tsx`, whose header already says: "This file is `.tsx`
because the hook's contract IS DOM … (the same reason `ChatStream.test.tsx` is `.tsx`)." The filename is
`src/hooks/useChatAttachments.test.tsx` EVERYWHERE it appears in this plan — done-when, Files, §C/§D/§E, the
Steps, the acceptance criteria, and the tauriBarrel provenance comment. Do NOT create a `.ts` twin.

**Why this shape cannot take the `_vite` shortcut:** `src/test/chatStreamFixtures.ts` imports `useSessions`
and `useSettings`, whose stores import `../lib/tauri` — so it HAS a transitive path into the mocked barrel.
The `vi.mock` probe matrix (status-file decisions log, and the scaffolding report's appendix) measured that a
factory body may reference only bindings from a module with NO transitive import of the mocked specifier
imported before anything that imports it; a helper-module delegation fails as **0 tests run** with
`Cannot access '__vi_import_N__' before initialization`. The winning shape is exactly what this file does:
factory bodies stay INLINE and self-contained (the tauri factory references only `vi` and its local
`actual`; the dialog factory only `vi`), same as `ChatStream.test.tsx`. Do NOT move the factories into
`chatStreamFixtures.ts`.

**The harness — the ONLY new code in the test file.** A host component that reproduces exactly the
`ChatStream` state/refs the five handlers close over, so the MOVED test bodies run UNCHANGED:

```tsx
function Harness(props: { imageCapable?: boolean; composerEnabled?: boolean }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const activeSessionIdRef = useRef<string | null>(useSessions.getState().activeSessionId);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Mirror ChatStream's re-sync: the paste-fallback session guard reads the LIVE
  // active session at paste time, exactly as `activeSessionIdRef.current =
  // activeSessionId` does in the component.
  activeSessionIdRef.current = useSessions.getState().activeSessionId;
  const api = useChatAttachments({
    setDraft,
    draftRef,
    activeSessionIdRef,
    composerRef,
    imageCapable: props.imageCapable ?? true,
    composerEnabled: props.composerEnabled ?? true,
  });
  // The handles `sendRelay` mirrors `send`'s closures over: the harness's OWN
  // draft/setDraft/setError (the hook owns none of them — exactly as
  // `ChatStream` keeps them).
  const relayDeps = { draftRef, setDraft, setError };
  return (
    <div data-testid="composer-island">
      <textarea
        ref={composerRef}
        value={draft}
        placeholder="Ask for follow-up changes"
        onChange={(e) => setDraft(e.target.value)}
        onPaste={api.handlePaste}
        onDrop={api.handleDrop}
      />
      <button onClick={() => api.handleAttachClick()}>Attach files</button>
      <button onClick={() => sendRelay(api, relayDeps)}>Send</button>
      {api.attachments.map((a, i) => (
        <div key={a.id}>
          <img alt={a.filename} src={a.objectUrl} />
          {/* the strip's badge: the marker number (1-based) the thumbnail carries */}
          <span aria-hidden="true">#{i + 1}</span>
          <button onClick={() => api.removeAttachment(a.id)}>
            Remove image attachment
          </button>
        </div>
      ))}
      {/* the composer's error line — `IpcErrorLine`'s role/class, reproduced so
          the staging rejection tests that assert them can move with the hook */}
      {error && (
        <div role="alert" className="text-ui-sm text-destructive mb-2 px-3">
          {error}
        </div>
      )}
    </div>
  );
}
```

The move substitutions: every `render(<ChatStream />)` in a moved test becomes `render(<Harness />)` (with
`<Harness imageCapable={false} />` for the one gate test); `screen.getByRole("textbox")` resolves to the
harness textarea exactly as before; `[data-testid="composer-island"]` is the harness root; the Attach/Send/
Remove buttons keep their accessible names.

**The send relay** (pre-wave-3 proxy for `send`) — drives the hook's boundary functions in `send`'s order so
the moved failed-send tests run against the hook contract:

```ts
// Minimal `send()` call-alike, pre-wave-3: drives the hook's boundary functions
// in `send`'s real order — (1) wipe the draft `setDraft("")` (the ARRIVES FIRST,
// exactly as `onCommitted`'s first statement at ChatStream.tsx:870 — the
// failed-send tests' premise "the text typed before Send is lost" depends on
// it), (2) move the whole staged set out of the composer (`moveOutForSend`,
// `onCommitted`'s held move), (3) await the (mocked) IPC, and on rejection (4)
// restore through `restoreHeldForSend`, which shifts the draft's markers by the
// number ACTUALLY restored and lands the error line in the same synchronous
// block (the React 19 batching contract). A relay that SKIPS step 1 makes the
// moved tests pass for the wrong reason (the draft would still hold the typed
// text) — the wipe is part of the contract under test.
function sendRelay(api: UseChatAttachmentsResult, deps: {
  draftRef: React.RefObject<string>;
  setDraft: (value: string) => void;
  setError: (value: string | null) => void;
}): void {
  const sessionId = "s1";
  // 1. onCommitted's FIRST statement: wipe the draft.
  deps.setDraft("");
  // 2. the held move — the whole staged set leaves `attachments` (held, not
  //    released; `moveOutForSend` reads api.attachmentsRef.current itself).
  const attachments = api.attachmentsRef.current;
  api.moveOutForSend(sessionId, new Set(attachments.map((a) => a.id)));
  // 3. the awaited IPC — the draft is read LIVE via the harness's draftRef
  //    (deps.draftRef, the same handle the real `send` uses), NOT from
  //    api.attachmentsRef (that is the attachment list, and it was just
  //    emptied by the move — a typo would send "" as the prompt text).
  void sendPrompt(sessionId, deps.draftRef.current, undefined)
    .catch((err: unknown) => {
      // 4. the catch: restore held → shift markers → land the error line in
      //    the same synchronous block. `setError`/`setDraft` are the harness's
      //    own setters.
      api.restoreHeldForSend(
        sessionId,
        err instanceof Error ? err.message : String(err),
        deps.setError,
        deps.setDraft,
      );
    });
}
```

The harness captures its own `draft`/`setDraft`/`setError` in a `deps` object handed to the relay (a
`draftRef` re-synced every render plus the two setters — the exact handles `ChatStream`'s `send` closes
over). This relay is explicitly provisional: wave 3 (`C1`) replaces it with the real `send`. **The moved
tests' `it` titles and assertion bodies stay verbatim** — the relay exists to make them pass in the hook
test file, not to change what they assert.

**The surface-pin test (NEW, house shape — `useMentionPicker`'s "returns exactly the fields…" precedent):**

```tsx
it("returns exactly the fields ChatStream threads into ComposerRow PLUS the held boundary and the two clears, and no more", () => {
  // `renderHook` with the minimum args — a stub `draftRef`/`activeSessionIdRef`
  // host wrapper; the exact wrapper is an implementation detail, the sorted key
  // list is the pin (house shape: `useMentionPicker`'s surface test asserts the
  // same sorted `Object.keys`).
  const { result } = renderHook(() =>
    useChatAttachments({ /* minimum args via a tiny wrapper */ }),
  );
  expect(Object.keys(result.current).sort()).toEqual([
    "attachments", "attachmentsRef", "stageFiles", "handlePaste", "handleDrop",
    "handleAttachClick", "removeAttachment", "moveOutForSend",
    "restoreHeldForSend", "releaseHeldForSend", "clearAll", "clearStaged",
  ].sort());
});
```

(Render it inside a host component or `renderHook` with a stub ref; the exact wrapper is an implementation
detail, the sorted key list is the pin.)

**The MOVED test list (authoritative — 34 tests; every `it` title kept verbatim, every body kept apart from
the harness substitutions):**

General `ChatStream` describe — paste/drop/staging/remove:
1. `"paste stages a thumbnail"` (1451)
2. `"paste of plain text is NOT intercepted"` (1462)
3. `"paste of plain text does NOT trigger the Rust clipboard read"` (1472)
4. `"paste with file items does NOT trigger the Rust clipboard read"` (1482)
5. `"WebKitGTK quirk: empty paste event falls back to the Rust clipboard read"` (1494)
6. `"WebKitGTK quirk fallback: no image on the clipboard stages nothing"` (1508)
7. `"WebKitGTK quirk fallback: a read error stages nothing (silent)"` (1518) — the SIX-pin WebKitGTK set is
   complete: 3, 4, 5, 6, 7 and 29. The six, by name: `"paste of plain text does NOT trigger the Rust
   clipboard read"` (3), `"paste with file items does NOT trigger the Rust clipboard read"` (4),
   `"WebKitGTK quirk: empty paste event falls back to the Rust clipboard read"` (5), `"WebKitGTK quirk
   fallback: no image on the clipboard stages nothing"` (6), `"WebKitGTK quirk fallback: a read error
   stages nothing (silent)"` (7), and the fallback-marker test `"the WebKitGTK empty-paste clipboard
   fallback inserts a marker too"` (29, in the marker describe) — ALL six moved. The straddle test
   (`"a paste-fallback clipboard read that straddles a session switch stages nothing (session guard)"`,
   21) exercises the same fallback but is NOT one of the six pins (its assertion is the session guard, not
   the read/fallback behaviour) — the six count is coherent: the straddle is moved too, item 21, and the
   "six pins" prose means exactly the six named here.
8. `"spreadsheet TSV is NOT intercepted over the synthetic PNG"` (1531)
9. `"non-image paste is rejected with an error line"` (1542)
10. `"SVG is rejected (allowlist)"` (1563)
11. `"oversized paste is rejected"` (1575)
12. `"ninth image is rejected at the cap"` (1591)
13. `"remove button un-stages"` (1611)
14. `"drop stages a thumbnail"` (1624)
15. `"drop STAGES while locked"` (1633)
16. `"unmount releases staged object URLs"` (1673) — the harness's own render → `unmount()`; the hook's
    unmount effect is what the assertion pins
17. `"feature is inert without the capability"` (1696) — render `<Harness imageCapable={false} />`

General `ChatStream` describe — send/held:
18. `"a failed send keeps attachments staged"` (1829) — via the send relay
19. `"a failed send restores the thumbnail WITHOUT releasing its object URL"` (1850) — via the send relay
20. `"unmounting while a send is in flight releases the held attachment"` (1873) — via the send relay +
    `unmount()`
21. `"a paste-fallback clipboard read that straddles a session switch stages nothing (session guard)"` (2238)
    — the harness re-syncs `activeSessionIdRef` from the store, so the guard works as in the component

`[image #N]` staging-marker describe:
22. `"a pasted screenshot leaves [image #1] in the draft"` (6308)
23. `"a second paste is #2 — the number counts THIS message's attachments in staging order"` (6317)
24. `"a batch of three staged in ONE event numbers ascending #1 #2 #3"` (6329)
25. `"a rejected file in a mixed batch inserts NO marker (the count comes from the staged list)"` (6343)
26. `"a fully rejected batch inserts nothing at all"` (6358)
27. `"the drop path inserts a marker too"` (6367)
28. `"the `+` file-picker path inserts a marker too"` (6376)
29. `"the WebKitGTK empty-paste clipboard fallback inserts a marker too"` (6388)
30. `"a drop onto an UNFOCUSED composer with a non-empty draft appends the marker at the END"` (6399)
31. `"a paste while the composer is focused lands at the CARET, not at the end"` (6418)
32. `"removing an attachment drops its marker and renumbers the survivors"` (6432)
33. `"the strip badges each thumbnail with the number its marker uses"` (6470) — the harness badges render
    `#{i + 1}` with `aria-hidden="true"`, exactly as the strip's badges

Failed-send restore describe:
34. `"a failed send restores at most MAX_CHAT_ATTACHMENTS and releases the overflow"` (6690) — via the send
    relay; asserts the restored cap, the overflow release
    (`URL.revokeObjectURL` `blob:mock-h8.png`), and the shifted marker `[image #8]`

(That is 34 moved tests — the enumerated list above IS the authoritative count; the arithmetic the wave
gate checks: `ChatStream.test.tsx` starts at **278** tests (measured at `27cec040`), loses exactly the 34
moved `it` blocks → **244**; `src/hooks/useChatAttachments.test.tsx` gains the same 34 moved tests PLUS the
new surface-pin test → **35**; the suite total therefore GROWS to **3354 passed** — the moved tests are
RELOCATED (−34 +34), but the surface-pin test is NEW (+1): 3353 − 34 + 35 = 3354. There is no
offsetting deletion anywhere. A total of **3353** means a test was DROPPED (likely the surface pin), and
**3355 or more** means a duplication; if the total comes out 3354 the implementation is CORRECT — do NOT
"fix" it by deleting a test to force the total back to 3353. The gate reconciles against these exact
numbers, it does not eyeball them. (`npx vitest run` on the untouched baseline reports `Test Files 160
passed (160)`, `Tests 3353 passed | 1 skipped (3354)`; after this task the full run reports `Test Files
161 passed (161)`, `Tests 3354 passed | 1 skipped (3355)` — one new test file, one new test.) The harness
send relay serves 18/19/20/34; all others run against the staging /
remove / fallback surface alone.)

**Flake note for the gate:** this box has two recorded known flakes — `MessageBubble.codeblock.test.tsx`'s
`it.each` (its `JSON` fence case) and `src/components/Reasoning.test.tsx`'s `"is O(last line), not
O(whole text) …"` test. A full-suite failure that matches either name is RE-RUN, never "fixed"; never
adjust a threshold to absorb a flake.

**What STAYS in `ChatStream.test.tsx` (integration — do not move):**

- The resumable-stored-session capability-provenance pin `"paste stages a thumbnail in a resumable stored
  session (capability read from the stored session)"` (998) — the provenance is
  `useChatSessionDerivations` → `ChatStream` wiring, untestable through the hook (receive-the-value
  boundary).
- The `+`-button enablement trio (1334, 1341, 1348) and the picker tests `"clicking `+` opens the file
  picker and stages the picked image"` / `"a cancelled picker (null) stages nothing"` / `"a picker
  selection of a non-image path is skipped (the read returns null)"` (1358/1387/1397) — ComposerRow button
  wiring + dialog hand-off integration.
- `"window-level drop backstop prevents navigation (drop outside the composer)"` (1646) —
  `useWindowDropBackstop`, a SEPARATE hook.
- `"shows the single placeholder for an image-capable fresh session (the capability if/else is gone)"`
  (1688) — ComposerRow.
- `"switching sessions clears staged attachments"` (1709) — the SESSION-SWITCH EFFECT is ChatStream's
  (`prevSessionIdRef` + `clearAll`/`releaseHeldForSend` wiring); the hook test has no effect to run.
- `"send delivers images with the prompt"` (1742) and `"staged thumbnails leave the composer AT SEND, not
  when the send resolves"` (1782) — the full send path (FileReader + `sendText` + `sendPrompt`
  imagery); wave 3 owns it.
- `"switching sessions while a send is in flight releases the LEFT session's held attachment"` (1897) —
  the session-switch effect integration.
- All the capability-regression send tests (1955, 1979, 2039, 2062, 2109, 2133) and the resume-capability
  pins (2349, 2380) — send-flow integration.
- The `[image #N]` feed-forward pins (6495, 6520, 6551, 6577, 6595) — the `#`-collision/mask SEND-TIME
  expansion seams.
- `"the renumbered draft is what gets sent"` (6450) — the renumber → SEND linkage (needs the real
  `sendText` read of the renumbered draft).
- `"a failed send renumbers the draft when it re-prepends the held attachments"` (6645) — the full
  end-to-end (stage → send → mid-turn paste → fail → restore → renumber → **send again asserting the
  image payloads**); the second send needs `readAttachmentAsBase64`/`sendText` — the hook-test relay
  cannot reproduce it without duplicating the send path.
- The whole queue-lock describe (6756), the whole Flush describe (6977), the whole
  "staging attachments is allowed while a turn is in flight" describe (7480 — its four tests assert the
  queue-fork + strip integration through the REAL `ChatStream`), the empty-state-film describe (7608), and
  the picker/commands/compaction describes.

**Line-count arithmetic to report:** `ChatStream.test.tsx` drops the 34 moved `it` blocks plus the
**marker describe's `composerValue` helper** (line 6304 — ALL its remaining uses leave with the moved
tests; verified: the kept marker-describe tests 6450/6495/6520/6551/6577/6595 use `getByRole("textbox")`
directly, never `composerValue()`). The **failed-send restore describe's `composerValue` (6627) /
`composerThumbs` (6633) / `png` (6640) STAY** — kept test 6645 (`"a failed send renumbers the draft when
it re-prepends the held attachments"`) uses all three. The queue-lock describe keeps ITS OWN
`composerValue`/`composerThumbs`/`png`/`queue` (6758/6763/6774/6770), and the staging-while-in-flight
describe keeps ITS OWN `composerThumbs`/`png` (7482/7493) — those four describes stay whole. The only
unconditional deletes are the marker describe's `composerValue` (line 6304) and the two moved imports (D3
below). `ChatStream.test.tsx` goes from **278** tests to **244**; the new file adds **35** (34 moved +
surface pin); suite total GROWS to **3354** (3353 − 34 + 35 = 3354).

### D. `src/components/ChatStream.test.tsx` (modify)

1. Delete the 34 moved `it` blocks listed in §C (both the bodies and the dead local helpers). The only
   unconditional helper delete is the **marker describe's `composerValue` (line 6304)** — every remaining
   use leaves with the moved tests; keep the restore describe's trio (6627/6633/6640), which kept test
   6645 still uses. `noUnusedLocals` (ON) is the backstop, but it cannot fire for a helper still referenced
   by a kept test — the 6645 check is the reason the trio stays.
2. LEAVE the module-scope scaffolding untouched: the two `vi.mock` calls and BOTH factory bodies stay
   INLINE (the A2 decision — "the tauri factory references only `vi.importActual` and no module-scope
   binding, so moving it buys nothing and costs the ordering constraint"; the queue/Flush/staging-while-
   in-flight integration tests still run them). The `beforeAll`/`beforeEach` stay.
3. Prune now-unused imports (re-run `pnpm build`/`tsc` — `noUnusedLocals` enforces): `readClipboardImage`
   (lines 7 / 4–19 import block) and `MAX_CHAT_ATTACHMENTS` (line 48) are used ONLY by moved tests —
   every one of their 10 + 5 call sites is inside a moved `it` block (the 10 `readClipboardImage` sites:
   1478, 1490, 1500, 1503, 1511, 1514, 1521, 2262, 2267, 6390 — all inside moved items 3/4/5/6/7/29/21;
   the `MAX_CHAT_ATTACHMENTS` uses at 6703/6707/6723/6730 are all inside moved item 34). Their only
   remaining mention in the kept tests is the `vi.mock` factory body, which is a string, not an import
   use: the factory is `importActual`-spreading and its override keys are strings — so BOTH imports leave
   `ChatStream.test.tsx` with the moved tests, unconditionally (this was verified by tracing every call
   site; `noUnusedLocals` will confirm the same conclusion, and a `pnpm build` that goes red on either one
   is the signal an implementer disagrees — stop and re-check, do not delete the check);
   `dropOnComposer` STAYS (the staging-while-in-flight describe uses it at 7519/7557/7588);
   `openFilePicker`/`readFileBytes`/`sendPrompt`/`deferred`/`flush` STAY. The `vi.mock` factory's
   `readClipboardImage: vi.fn().mockResolvedValue(null)` override stays (the kept tests don't read it, but
   the factory is verbatim — do not edit the factory).
4. The remaining attachment tests keep the strip/badge/element queries they had — nothing about the
   component's markup changed.

### E. `src/lib/tauriBarrel.test.ts` (modify — SAME commit as the new test file)

The assertion is at `it("the scanner sees the mock seam it exists to protect")` (line ~398). It first
pins the SET of `.test.ts` files under `src/` that `vi.mock` the tauri barrel by module path, then pins how
many of that set spread `vi.importActual`. Constraint #7 in the dispatch text is explicit: **cite the
assertion, never copy its numbers into this plan — the implementer reads the CURRENT values from the file
and bumps both by +1.** The two edits:

1. BOTH counts +1 — the new `src/hooks/useChatAttachments.test.tsx` mocks the barrel BY MODULE PATH with an
   `importActual`-spreading factory, so the set grows by one in both counts. (The `mockers` filter
   `/^\s*vi\.mock\(\s*["'][^"']*lib\/tauri["']/m` matches `vi.mock("../lib/tauri",)` — on comment-stripped
   text — the same way it already matches `ChatStream.test.tsx`.)
2. Extend the provenance comment's recorded history with one clause naming the file, e.g.:
   `and <N> -> <N+1> when the chatstream decomposition moved ChatStream's attachment tests into src/hooks/useChatAttachments.test.tsx, which mocks the barrel the documented way`.

### F. Behaviour MOVED, not improved

- The harness send relay is explicitly provisional — wave 3 replaces it with the real `send`. It exists
  only to let the moved restore tests run against the hook boundary; it re-implements no production logic
  (the boundary functions ARE the production logic it drives).
- The harness `ErrorLine` elements reproduce `IpcErrorLine`'s role/classes because the moved rejection
  tests assert them; the component-level rendering pin already lives in the moved tests' assertions and
  the queue/Flush integration tests that stay.
- The queue-fork's clear (two direct writes → `clearStaged()`) is a RE-POINT, not an improvement — the
  fork's behaviour (release nothing; URLs move into the entry) is byte-identical because `clearStaged` is
  defined to release nothing. Nothing else changes shape; in particular the failed-send restore's
  `if (back.length > 0)` shift guard moves VERBATIM (it still only runs when something was actually
  restored).
- ANYTHING else that looks improvable goes in a follow-up note, not this diff. If a deliberate behaviour
  change becomes necessary, it gets its own commit and a status-file decisions-log line (per the status
  file's rule), never a silent tweak.

**Steps:**

1. **TDD red:** create `src/hooks/useChatAttachments.test.tsx` FIRST with the module-scope block, the
   harness, the send relay, the surface-pin test, and the 34 moved `it` blocks (bodies verbatim, the
   `render(<ChatStream />)` → `render(<Harness … />)` substitution applied). It references a module that
   does not exist yet, so the file cannot compile — that is the expected red.
   - Run `npx vitest run src/hooks/useChatAttachments.test.tsx` — expect an import-resolution failure for
     `./useChatAttachments`. If it passes unexpectedly, stop and investigate.
2. **Implement the hook:** `src/hooks/useChatAttachments.ts` per §A — the five handlers moved verbatim
   (substitution table only), the boundary operations, the unmount effect, the interface exports.
   - Run `npx vitest run src/hooks/useChatAttachments.test.tsx` —
     Did the moved tests pass? The surface-pin test must pass. Fix the harness/relay wiring (not the
     production bodies) until green.
3. **Wire `ChatStream.tsx` (B1–B3), prune imports.** Run `npx tsc --noEmit` (fastest feedback) and fix
   every `noUnusedLocals`/type error before the builds.
4. **Move out of `ChatStream.test.tsx` (D):** delete the 34 moved blocks, prune the imports, delete
   unneeded local helpers.
   - Run `npx vitest run src/components/ChatStream.test.tsx` —
     Did all remaining tests pass? The kept integration tests (queue lock, Flush, staging-while-in-
     flight, feed-forward, capability-regression) prove the hook wiring through the real component. If a
     kept test fails on a binding the hook returned, fix the hook's return/`ChatStream` re-point (the
     plan's interface is authoritative) — never weaken a test.
5. **Update the barrel pin (E):** bump both counts to the values the file then reads, extend the comment.
   - Run `npx vitest run src/lib/tauriBarrel.test.ts` — green with the new numbers.
6. **Per-file commands:**
   - `npx vitest run src/hooks/useChatAttachments.test.tsx`
   - `npx vitest run src/components/ChatStream.test.tsx`
   - `npx vitest run src/lib/tauriBarrel.test.ts`
   - `npx tsc --noEmit`
   Then the full gate, from the repo root:
   - `pnpm test`
   - `pnpm build`
   **Reconcile the counts, do not eyeball them:** the full-suite total must read **3354 passed** (the
   moved tests are relocated −34 +34, and the surface-pin test is NEW +1: 3353 − 34 + 35 = 3354 — the suite
   grows by exactly one test, the surface pin), and `ChatStream.test.tsx` alone must read
   **244** (`npx vitest run src/components/ChatStream.test.tsx`). Any other number means a test was
   dropped, duplicated, or silently skipped — stop and investigate before committing. In particular, a
   total of **3353** means a test was dropped (the surface-pin test is the likely casualty) and **3355+**
   means a duplication — 3354 is the CORRECT result, so never "fix" a green 3354 run. A full-suite failure
   in an unrelated file that is one of the two recorded known flakes (the status file's list) is re-run,
   not "fixed".
7. Commit with message:
   `refactor(chatstream): extract attachment lifecycle into useChatAttachments (issue #135 §1)`

**Acceptance criteria:**
- [ ] `src/hooks/useChatAttachments.ts` exists; the hook returns exactly the pinned 12-name surface
      (`attachments`, `attachmentsRef`, `stageFiles`, `handlePaste`, `handleDrop`, `handleAttachClick`,
      `removeAttachment`, `moveOutForSend`, `restoreHeldForSend`, `releaseHeldForSend`, `clearAll`,
      `clearStaged`) and the surface-pin test passes.
- [ ] `ChatStream.tsx` calls the hook once in the unconditional block above the `if (!activeSessionId)`
      early return (directly after the `draftRef.current = draft;` re-sync), destructures all 12 names it
      uses, and no longer declares the moved state/handlers/refs/effect —
      `grep -n "const stageFiles" src/components/ChatStream.tsx` returns NOTHING, and the moved imports are
      gone from it (verified by `pnpm build`'s `noUnusedLocals`).
- [ ] The queue-fork's staged clear at `ChatStream.tsx` (~736–745) now calls the hook's `clearStaged()`
      (ref + state emptied, NOTHING released); `grep -n "setAttachments(\[\])" src/components/ChatStream.tsx`
      returns exactly ONE hit — the session-switch effect's `clearAll` path — and `URL.revokeObjectURL` is
      never called inside the locked fork (the "never revoke here" ADR-0069 contract; the queue-move pins
      stay green).
- [ ] The 34 moved tests in `src/hooks/useChatAttachments.test.tsx` still assert the WebKitGTK empty-paste
      clipboard fallback (all six pins), the staging/marker/renumber/remove surface, and the failed-send
      restore contract (keep-staged, no-revoke, unmount-held-release, cap + overflow release).
- [ ] The feed-forward `#`-collision/mask tests, the queue-lock / Flush / staging-while-in-flight
      attachment pins, the capability-provenance and session-switch-effect pins, and the full-send-rolling
      restore tests (`"a failed send renumbers the draft…"`, `"switching sessions while a send is in
      flight…"`, `"the renumbered draft is what gets sent"`) STAY in `ChatStream.test.tsx` and pass.
- [ ] `src/lib/tauriBarrel.test.ts`'s mock-seam assertion still passes with the new count (implementer
      read the values from the file and bumped both by +1 in the SAME commit); its provenance comment names
      `src/hooks/useChatAttachments.test.tsx`.
- [ ] Counts reconcile EXACTLY: full suite `pnpm test` = **3354 passed | 1 skipped (3355)** — 161 test
      files (160 + the new `useChatAttachments.test.tsx`); 3353 − 34 moved + 35 in the new file = 3354
      (relocated −34 +34, plus the NEW surface-pin test +1), `ChatStream.test.tsx` alone = **244** (278 − 34),
      the new
      file = **35** (34 moved + the surface pin). Any deviation is investigated, never absorbed — and a
      result of 3353 (a dropped test, likely the surface pin) or 3355+ (a duplication) is a bug to fix,
      while 3354 is the CORRECT count and must not be "fixed" by deleting a test.
      `ChatStream.tsx` shrinks by roughly the handler span (~230 lines: five handlers + the extracted state
      block + the unmount effect + the imports, offset by the hook call).
- [ ] Nothing outside the Owns set changed — plus `src/lib/tauriBarrel.test.ts` (its pin update is the
      one sanctioned, mandatory reach outside the four files). `git status` shows exactly:
      `src/hooks/useChatAttachments.ts`, `src/hooks/useChatAttachments.test.tsx`,
      `src/components/ChatStream.tsx`, `src/components/ChatStream.test.tsx`,
      `src/lib/tauriBarrel.test.ts`.
- [ ] Full gate green from the repo root: `pnpm test` (**3354 passed | 1 skipped**, 161 test files) and
      `pnpm build` (exit 0).
