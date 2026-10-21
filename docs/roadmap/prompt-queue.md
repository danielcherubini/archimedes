---
status: committed
issue: https://github.com/danielcherubini/archimedes/issues/74
done-when: With a turn in flight on a live Session, typing in the composer and pressing Enter leaves the composer empty, drops a `Queued` row into the stack between the transcript island and the composer, and sends that text as an ordinary turn the moment the current one settles; the row's pencil re-edits it in place and its trash removes it, and neither action requires the turn to end first. `pnpm test` and `pnpm build` are green. No Rust file is touched.
---

# Prompt queue Plan

**Goal:** Let the user send prompts while a **Session**'s turn is in flight by queueing them as visible, editable, deletable rows between the transcript and the composer, and **Flush**ing them one at a time as each turn settles.

**Architecture:** A renderer-only store (`src/store/queuedPrompts.ts`) holds each **Session**'s ordered **Queued prompts**. `ChatStream`'s `send()` forks to `enqueue()` while `composerLocked`, and a new `sendText()` shared by manual send and **Flush** keeps the two byte-identical below the composer. A new hook detects the `inTurn` falling edge and **Flush**es the head. The **Supervisor** is never told a queue exists — `send_prompt_with_images`'s `pending_turn` claim (ADR 0069) is untouched, and there is no Rust change.

**Tech stack:** React 19 + TypeScript, Zustand (v5 `create`), `motion` (`motion/react`), lucide-react, Tailwind, Vitest + Testing Library (jsdom).

**Two corrections to the approved spec, both resolved during planning:**

1. **The Flush fires only for the visible Session.** The spec said a background **Session**'s queue drains too. It cannot be done correctly: `sendText` expands **Mentions** through `useMentionCatalogs(spacePath)` where `spacePath = useActiveSpaceCwd()` (`ChatStream.tsx:442-445`), which is keyed on the ACTIVE **Session**'s Space — so flushing a background **Session** would expand its `$name` against the WRONG **Space**'s catalogs. `ChatStream` also renders only the active **Session**, and `App.tsx:424-425` swaps `SettingsPage` in wholesale, so no surface could run it correctly. The queue stays per-**Session** (nothing is lost on a tab switch); a background queue holds until that **Session** is on screen again AND goes idle — it does not drain retroactively for a settle that happened off screen, because the edge is detected from a per-component snapshot and a hidden **Session** produces no edge for a fall it was not observing. That is the honest behaviour and Task 5's hook is written to it. `CONTEXT.md`'s **Prompt queue** entry asserts the old claim and is corrected in Task 5.
2. **A flushed attachment is released by the DISPATCH path, and NOT by `ChatStream`'s unmount cleanup.** Queue attachments live in the store, which survives a `ChatStream` unmount (the Settings view unmounts it, `App.tsx:424-425`), so releasing them on unmount would break the previews of a queue that outlives the component. The existing unmount cleanup (`ChatStream.tsx:317-329` — NOT `:807`, which is the `archimedes:insert-skill` listener) keeps releasing exactly what it releases today — the composer's staged list and `heldForSendRef` — and gains nothing. The three owners of a queue attachment's object URL are therefore: the **Flush**'s dispatch path (on success — `flushHead` releases them, because `send()`'s `heldForSendRef` release is composer-only and `forget` deliberately skips a `"sent"` entry), the **delete** path (`forget` on a `"deleted"` entry), and **`clearSession`** on close/delete.

**Validation bar** (`AGENTS.md`): `pnpm test` and `pnpm build` from the repo root. There is no frontend formatter or linter configured (`package.json` has no `lint`/`format` script), so no format/lint step appears below. `cargo` checks are in the bar only because the bar is unconditional; this plan touches no `.rs` file.

**Line anchors are indicative, not authoritative.** Every `file.ts:123` citation below was read off the tree at plan-writing time; Tasks 2, 3, 5 and 6 all edit the same file, so anchors shift as the work lands. Re-locate each site by grepping the quoted code or the named identifier, never by the number. Where a step quotes a condition verbatim (`if (composerLocked || !imageCapable) return;`), that string is the anchor.

---

## Parallelisation

**Verdict:** PARALLEL — 2 waves of 2, then three serial tasks.

- **Wave 1: Task 1, Task 2** — Task 1 creates only `src/store/queuedPrompts.{ts,test.ts}`; Task 2 modifies only `src/components/ChatStream.{tsx,test.tsx}`. Disjoint, and Task 2's extraction imports nothing from Task 1 (it is behaviour-preserving on existing code).
- **Wave 2: Task 3, Task 4** — Task 3 modifies `ChatStream.{tsx,test.tsx}`; Task 4 creates only `src/components/chat/QueueRow.{tsx,test.tsx}` + `QueueRows.{tsx,test.tsx}`. Disjoint; both import Task 1's store, which is committed by then, and neither imports the other.
- **Tasks 5, 6, 7: serial** — Task 5 (mount + **Flush**) and Task 6 (un-gate the staging paths) both modify `ChatStream.tsx` and `ChatStream.test.tsx`, so neither can join a wave or each other. Task 7's wiring depends on Task 5's mount being observable in its assertions.

**In-wave verification is SCOPED to the task's own test file** (`pnpm test <its own test files>` — vitest loads only those files plus the modules they import, which no sibling touches). **Never run `pnpm build`, bare `pnpm test`, or `npx tsc --noEmit` inside a wave**: `vite build` writes the shared `dist/`; a full-suite run measures a sibling's half-finished edits; and `tsc --noEmit` writes nothing but type-checks the **whole tree**, so in a wave it reports a sibling's in-flight errors as your own — a red gate that cannot be fixed from inside the task. The tree-wide checks run once after each wave, serially, by the orchestrator:

- after **Wave 1**: `npx tsc --noEmit`, `pnpm test`, `pnpm build`
- after **Wave 2**: `npx tsc --noEmit`, `pnpm test`, `pnpm build`

Serial Tasks 5/6/7 keep their `tsc` and full-suite steps — no sibling is editing while they run.

---

### Task 1: The queue store

**Parallel:** wave 1 — disjoint from Task 2 (`src/components/ChatStream.tsx`, `src/components/ChatStream.test.tsx`); imports nothing Task 2 creates.

**Context:**
Sending a prompt mid-turn is refused today at `src/components/ChatStream.tsx:885` (`send()` returns early on `composerLocked`). The queue that replaces that refusal is renderer state by decision (ADR 0069, `docs/decisions/0069-*.md`): the **Supervisor**'s one-turn-at-a-time invariant stays untouched, and every queue operation (edit, delete, **Flush**) is a plain list mutation. This task creates only the store and its tests — no UI, no wiring into `ChatStream` (that is Tasks 3 and 5), so it can be verified in isolation.

Model it on `src/store/permissions.ts` (58 lines, one file per interactive surface, keyed by `sessionId`, and `dismissSessionPrompts` deletes the key rather than setting an empty array — copy that).

**Files:**
- Create: `src/store/queuedPrompts.ts`
- Test: `src/store/queuedPrompts.test.ts`

**What to implement:**

```ts
// src/store/queuedPrompts.ts
import { create } from "zustand";
import { releaseAttachment, type ChatComposerAttachment } from "../lib/chatAttachments";

export interface QueuedPrompt {
  id: string;                        // crypto.randomUUID() at enqueue; React key + edit/delete handle
  text: string;                      // the RAW draft — NEVER the Mention-expanded text
  attachments: ChatComposerAttachment[];  // MOVED out of the composer, not copied
  state: "queued" | "editing";
  /** Set at exit; the row calls `forget` when its animation ends. `undefined` = live. */
  leaving?: "sent" | "deleted";
  /** A Flush of this entry failed. Such an entry is LIVE (it renders and
   * counts) but is never a `takeHead` candidate — only a user edit clears it.
   * This is what stops a failed send's own idle edge from re-sending it. */
  failed?: boolean;
}

interface QueuedPromptsState {
  bySession: Record<string, QueuedPrompt[]>;   // ordered: the first LIVE entry is next to Flush
  enqueue: (sessionId: string, prompt: QueuedPrompt) => void;
  requeueHead: (sessionId: string, prompt: QueuedPrompt) => void;
  updateText: (sessionId: string, id: string, text: string) => void;
  setEditing: (sessionId: string, id: string, editing: boolean) => void;
  removeAttachment: (sessionId: string, id: string, attachmentId: string) => void;
  takeHead: (sessionId: string) => QueuedPrompt | undefined;
  markLeaving: (sessionId: string, id: string, reason: "deleted") => void;
  forget: (sessionId: string, id: string) => void;
  clearSession: (sessionId: string) => void;
}

/** The ONLY read path for the UI (row count, "render anything?", row list).
 * A `failed` entry is LIVE — the user must see it and be able to fix it. */
export function livePrompts(list: QueuedPrompt[] | undefined): QueuedPrompt[] {
  return (list ?? []).filter((p) => !p.leaving);
}
```
There is deliberately **no** `flushablePrompts` helper: the failed-and-live rule is applied once, inside `takeHead`, and a second exported filter would be a second place the rule can drift from the one that decides what actually sends.

Rules, each answering a hazard that already exists in this codebase:

- **`takeHead` marks, it does not remove.** It finds the first entry with `!leaving && !failed && state !== "editing"`, sets its `leaving = "sent"`, and returns it.
  **Why `editing` is excluded:** a turn can settle while the user is typing in a row's editor. The store holds the text from the LAST Save, so sending the head then would ship text the user was in the middle of replacing — the exact failure the `draftRef` staleness guard exists to prevent in `send()` (`:985-993`). Skipping it sends the entries behind it and leaves the edited row alone until the user saves. This is the same shape as `failed`: an entry that is not ready yields the turn to the ones behind it, rather than blocking them or being sent in a stale state. The row must stay mounted to play its exit animation, and the entry must be invisible to the NEXT **Flush** — `leaving` is what makes both true.
- **`takeHead` is synchronous and must stay that way.** Read `get()`, then `set()` with no `await` between: JS is single-threaded, so the read-and-mutate pair is atomic with respect to a manual send racing it. An `async` `takeHead` breaks that guarantee silently.
- **`forget` is the only remover.** It drops the entry by id, releases the entry's attachments **only when its `leaving === "deleted"`** (for `"sent"`, `sendText`'s existing `heldForSendRef` machinery releases them — a second release would be a double-revoke on a URL the send path already owns), and `delete`s the `bySession` key when the list empties (the `dismissSessionPrompts` pattern, so the map cannot accumulate empty arrays). Call `releaseAttachment` BEFORE the `set(...)` call, never inside the updater.
- **`clearSession` releases every attachment it drops**, for both `leaving` values — it is the session-close path, where nobody else owns them any more.
- **`markLeaving` takes only `"deleted"`.** The `"sent"` half is `takeHead`'s job; giving one field two writers with one name each is how a row ends up leaving twice.
- **`updateText` clears `failed`** — saving an edited prompt IS the retry gesture, so it needs no separate retry API and no `clearFailure` action (a second way to clear the flag is a second place for it to be cleared by accident). Do NOT clear it in `setEditing`: opening the editor is not a retry request.
- **`updateText` / `setEditing` / `removeAttachment` never touch `leaving`**, and `removeAttachment` must NOT call `releaseAttachment` from inside the updater — read the target from `get()` and release before `set()`.

Do NOT add: reordering, an `updateAll`, a persistence layer, a `Record` keyed by prompt id (the array order IS the send order), or any `useSessions` import (the store must not know what a turn is).

**Steps:**
- [ ] Write `src/store/queuedPrompts.test.ts` covering: `enqueue` appends and preserves order; `takeHead` returns the first LIVE entry and marks it `leaving: "sent"`; a second `takeHead` skips that entry and returns the next; `takeHead` on an empty or all-leaving list returns `undefined`; `requeueHead` puts an entry back at the FRONT with `leaving` cleared and does NOT release its attachments; `takeHead` skips a `failed` entry and returns `undefined` when every live entry is failed, while `livePrompts` still lists it; `takeHead` skips an entry whose `state` is `"editing"` and returns the one behind it, and returns `undefined` when the only live entry is being edited; `updateText` on a failed entry clears `failed`; `livePrompts` excludes leaving entries; `markLeaving(id,"deleted")` hides an entry from `livePrompts` and `takeHead`; `forget` removes it and deletes the key when the list empties; `forget` on a `deleted` entry calls `URL.revokeObjectURL` for each attachment and on a `sent` entry does not; `clearSession` releases and deletes the key; `updateText`/`setEditing`/`removeAttachment` mutate only their own field; two sessions' queues never interfere.
  - Follow the suite's existing URL idiom (`src/lib/chatAttachments.test.ts:5-8`): in a `beforeAll`, `URL.createObjectURL = vi.fn((file: File) => \`blob:mock-${file.name}\`)` and `URL.revokeObjectURL = vi.fn()`, then assert on `(URL.revokeObjectURL as Mock).calls`. Do NOT rely on `vi.spyOn(URL, ...)` — both assignment and the spy work under this jsdom version, but the assignment form is what every existing attachment test uses, and a fixture that diverges from the suite's idiom reads as intentional. Build attachments as literal `ChatComposerAttachment` objects (`{ id, file: new File([...], "a.png", { type: "image/png" }), filename, mimeType, sizeBytes, objectUrl: "blob:mock-a.png" }`) rather than through `createChatComposerAttachment`, so a store test cannot fail because of the attachment factory.
- [ ] Run `pnpm test src/store/queuedPrompts.test.ts`
  - Did it fail to resolve `./queuedPrompts`? If it passed, the file already exists — stop and investigate.
- [ ] Implement `src/store/queuedPrompts.ts` as specified above.
- [ ] Run `pnpm test src/store/queuedPrompts.test.ts`
  - All green? If not, fix and re-run before continuing.
- [ ] Do NOT run `npx tsc --noEmit` here — it type-checks the whole tree and a sibling is mid-edit in wave 1; the orchestrator runs it after the wave.
- [ ] Commit: `feat: add the prompt queue store`

**Acceptance criteria:**
- [ ] `pnpm test src/store/queuedPrompts.test.ts` is green.
- [ ] `livePrompts` is exported and is the only way the UI reads the list; the failed-entry rule lives ONLY in `takeHead`.
- [ ] No file other than the two above is created or modified.

---

### Task 2: Extract `sendText` out of `send()`

**Parallel:** wave 1 — disjoint from Task 1 (`src/store/queuedPrompts.ts`, `src/store/queuedPrompts.test.ts`); imports nothing Task 1 creates.

**Context:**
The **Flush** must not grow a second send path. Today `send()` (`src/components/ChatStream.tsx:873-1196`) owns everything a queued prompt will still need at its own turn — the `[image #N]` marker mask, `expandMentions`, the images-empty normalisation, `addUserMessage`, `beginTurn`, `sendPrompt` — and a parallel implementation would drift from the original, invisibly, until a queued **Mention** expanded differently from a typed one.

This task is a **behaviour-preserving extraction**: no new behavior, no new prop, no store change. Its acceptance criterion is that the EXISTING `ChatStream.test.tsx` passes **unmodified** — if an existing test fails, the extraction is wrong, so fix the extraction and never the test.

**Where the seam goes, and why it is there.** The extraction must sit where the data the tail needs is already complete. Read `send()` first: the base64 read produces `images` (each carrying an `id`), the `liveIds` reconcile filters it, `sentIds` is derived from it, `setDraft("")` runs, `addUserMessage` runs, the `heldForSendRef` block uses `sentIds`, then `beginTurn` and `sendPrompt`. So `sendText` takes the **reconciled `images`** (not the stripped `ImageRef[]`) and owns everything from the expansion onward, and it hands `sentIds` BACK to the caller through one callback, because only `send()` has the composer to move thumbnails out of.

**Files:**
- Modify: `src/components/ChatStream.tsx`
- Test: `src/components/ChatStream.test.tsx` (existing assertions must pass untouched)

**What to implement:**

```ts
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
  images: { id: string; name: string; mimeType: string; sizeBytes: number; data: string }[] | undefined,
  onCommitted: (sentIds: Set<string>) => void,
): Promise<StopReason | null> => { /* ... */ };
```

`sendText`'s body, MOVED VERBATIM from `send()` (move the logic AND its comments — only the two items marked ADJUST change a token, and they are the same two statements today):

1. The marker mask (`/\[image #(\d+)\]/g` → `\uE000`), the pasted-sentinel guard, `expandMentions(masked, { skills, agents, mcpServers: mcpMentionsEnabled ? mcpServers : [] })`, and the BOUNDED un-mask. Every comment about why the mask is not cosmetic and why the sentinel needs a guard travels with it — do not summarise them.
2. The images-empty normalisation (`if (images !== undefined && images.length === 0)`), SAME relative position (immediately after expansion, before `sentIds`). **ADJUST:** its `if (!text) return;` becomes `if (!text) return null;` — a bare `return;` in a `Promise<StopReason | null>` function is an implicit `undefined` and `tsc` rejects it. Comment the arm with its REAL reachability, citing the existing test: stage attachments, delete the `[image #N]` marker text BY HAND so the draft stays empty when the read lands, then remove every thumbnail during the `FileReader` await so the reconcile yields `images === []` with `text === ""`. Do NOT claim that removing a thumbnail alone reaches this arm — it does not: `removeAttachment` renumbers the draft, so the **stale-draft guard** aborts first, and `ChatStream.test.tsx:2368-2377` documents exactly that.
3. `const sentIds = new Set(images?.map((i) => i.id) ?? []);` and `const imageRefs = images?.map(({ id: _ignored, ...ref }) => ref);` — see the `noUnusedLocals` note below, this destructure needs handling.
4. `onCommitted(sentIds)`.
5. `addUserMessage(sessionId, text, imageRefs)`.
6. `beginTurn(sessionId)`.
7. The two-arg-vs-three-arg `sendPrompt` call exactly as today (`imageRefs ? sendPrompt(id, text, imageRefs) : sendPrompt(id, text)`) — vitest compares arg arrays by length, so an explicit `undefined` third arg breaks the existing `toHaveBeenCalledWith("s1", "hello")` pins.
8. **ADJUST:** `return stopReason` (today `turnCompleted` runs immediately before it). **`sendText` never calls `turnCompleted` and never catches.**

**Why `turnCompleted` stays in the caller — the trap in this task.** Today the success path releases `heldForSendRef` and THEN calls `turnCompleted` (`:1118-1123`), and the `catch` calls `turnCompleted("end_turn")` BEFORE `setError` (`:1125-1131`). Moving `turnCompleted` into `sendText` would invert both, and an existing test passes only because `setError` and the attachment restore land in ONE React 19 batch after `turnCompleted` (the comment at `:1141-1144` says so). So `sendText` returns or throws; each caller owns its settle.

`send()` becomes, in this order: the empty/`draftIsMarkerOnly` guards → `sendingSessionsRef` → `setError(null)` → the `parseComposerCommand` block → the `!isLive` auto-resume block → the base64 `Promise.all` read + `liveIds` reconcile → the `activeSessionIdRef` and `draftRef` staleness guards → `await sendText(targetSessionId, rawText, images, (sentIds) => { setDraft(""); /* + the heldForSendRef hold-and-filter block, verbatim, filtering by sentIds */ })` → `if (stopReason === null) return;` → the success release of `heldForSendRef` + `turnCompleted` → the `catch` UNCHANGED (`turnCompleted(…, "end_turn")`, `describeIpcError`, `setError`, the attachment-restore block with its `MAX_CHAT_ATTACHMENTS` ceiling and `shiftImageMarkers`) → `finally { sendingSessionsRef.current.delete(…) }`.

Two things that look like changes and are not — comment both:
- `setDraft("")` and the held-attachment block are merged into ONE `onCommitted` callback fired at `setDraft`'s old position. Today the held block runs three statements later, with **no `await` between them**, and both are synchronous ref/state writes React 19 batches into the same commit — so moving it a few lines earlier inside the same synchronous block is observationally identical.
- `if (stopReason === null) return;` sits AFTER the `sendText` await, so it still runs `finally` and releases the double-send slot — exactly what today's `return` did.

`noUnusedLocals` / `noUnusedParameters` are ON (`tsconfig.json`), so item 3's `({ id: _ignored, ...ref })` discard is a compile error — an underscore does not exempt a destructured binding. Replace it with a field-by-field build, `images?.map((i) => ({ name: i.name, mimeType: i.mimeType, sizeBytes: i.sizeBytes, data: i.data }))`, and annotate the result `ImageRef[] | undefined`. Add `ImageRef` to the `../lib/chatAttachments` import list, and declare ABOVE the component:
```ts
/** The reconciled attachment payload `sendText` takes (id-bearing, unlike the
 * `ImageRef` that goes on the wire). Exported because Task 5's Flush builds one. */
export type SendTextImages = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  data: string;
}[];
```
Use it in `sendText`'s signature instead of the inline literal.

Do NOT: change the guard conditions (Task 3 owns them), add a queue, move `turnCompleted`, or touch `ComposerRow.tsx`.

**Steps:**
- [ ] Read `send()` end to end (`:873-1196`), and before moving anything, annotate in comments the eight `sendText` items and the two `turnCompleted` sites.
- [ ] Run `pnpm test src/components/ChatStream.test.tsx` — baseline. Record the pass count.
  - Not green at baseline? Stop: the branch is broken before this task and the criterion below is meaningless.
- [ ] Extract `sendText`, wire `onCommitted`, honour `StopReason | null` at the arm and at the caller, and rewrite the `imageRefs` build as specified.
- [ ] Run `pnpm test src/components/ChatStream.test.tsx`
  - Same pass count, zero failures, `toHaveBeenCalledWith("s1", "hello")` still green? If a test changed behaviour, fix the extraction — do NOT edit the test.
- [ ] Do NOT run `npx tsc --noEmit` — it type-checks the whole tree while Task 1 is mid-write on `src/store/queuedPrompts.ts`; the orchestrator runs it after the wave.
- [ ] Commit: `refactor: extract sendText from the composer's send path`

**Acceptance criteria:**
- [ ] `ChatStream.test.tsx` passes unmodified at the same count as baseline.
- [ ] `sendText` takes the reconciled `images`, owns the expansion, and never calls `setDraft` / `setAttachments` / `turnCompleted`.
- [ ] The `null` arm returns before `onCommitted`, so a bailed send leaves the draft intact (state this in the arm's comment).
- [ ] No behavior observable by a user changed.

---
### Task 3: Fork `send()` to the queue while locked

**Parallel:** wave 2 — disjoint from Task 4 (`src/components/chat/QueueRow.tsx`, `QueueRows.tsx` and their tests); imports Task 1's store, committed in wave 1, and nothing Task 4 creates.

**Context:**
Today `send()` bails silently when `composerLocked` is true, so words typed during inference have nowhere to go. The fork: while locked, a non-empty draft is **enqueued** instead of refused. Three carve-outs are load-bearing and were decided deliberately:

- An empty or marker-only draft is still a silent no-op (nothing to queue).
- A **Composer command** is NEVER queued. ADR 0044's defining act is that `/compact` is CONSUMED — nothing is sent, no user row persists — while a queue entry's whole contract is "becomes an ordinary `send_prompt`". Mid-turn it gets visible feedback via `addSystemLine` instead of today's dead key.
- Attachments MOVE into the entry (the object URLs are kept, never revoked and recreated) so previews survive the trip, and the **image marker** numbers travel with the text untouched — the numbering is per-message, and message-ness is preserved by the move, so there is nothing to renumber.

`composerLocked` (`:222`) is `workingOrInTurn || agentState === "blocked" || compacting !== undefined`; all three enqueue. A compaction is serialised ahead of the next prompt by the harness itself (`ControlCmd::Compact`, `src-tauri/src/agent/harness/loop.rs:545`), and a `blocked` **Gate** means the turn is unsettled so no **Flush** can fire and the queue is honest about waiting.

**Files:**
- Modify: `src/components/ChatStream.tsx`
- Test: `src/components/ChatStream.test.tsx`

**What to implement:**

Split the current guard
```ts
if ((!hasImages && (rawText === "" || draftIsMarkerOnly(rawText))) || composerLocked) return;
```
into the emptiness check first (unchanged no-op), then the lock check:

```ts
if (!hasImages && (rawText === "" || draftIsMarkerOnly(rawText))) return;
if (composerLocked) {
  const command = parseComposerCommand(rawText);
  if (command) {
    addSystemLine(targetSessionId, `/${command.name} runs when this turn ends — try again then.`);
    return;
  }
  // The URLs MOVE with the text: never revoke here, or the queue row's preview
  // and the later send both lose the file.
  const moved = attachmentsRef.current;
  attachmentsRef.current = [];
  setAttachments([]);
  useQueuedPrompts.getState().enqueue(targetSessionId, {
    id: crypto.randomUUID(),
    text: rawText,
    attachments: moved,
    state: "queued",
  });
  setDraft("");
  return;
}
```

Notes:
- `crypto.randomUUID()` is already the app's id source (`src/lib/chatAttachments.ts:54`) — no new dependency.
- The fork lives AFTER `sendingSessionsRef.current.add(...)`? NO — it must be BEFORE it, and before the `try`, so a queueing press never occupies the double-send slot. Place it after `if (!targetSessionId) return;` and the `rawText` computation. Because it returns before the `try`, it must not rely on the `finally` for cleanup — and it needs none.
- `addSystemLine` is already destructured from the store in this component.
- Leave `composerLocked` itself and `ComposerRow`'s `disabled` props exactly as they are: the Send button stays disabled during a turn, and Enter reaches `send()` via `ComposerRow`'s key handler. Do NOT "helpfully" enable the button.
- Import `useQueuedPrompts` (and `type QueuedPrompt` if needed) from `../store/queuedPrompts`.

**Steps:**
- [ ] Write failing tests in `ChatStream.test.tsx`, seeding a live session with `useSessions.setState({ sessions: [/* { sessionId: "s1", cwd: "/w", capabilities: { promptCapabilities: { image: true } }, ... } */], activeSessionId: "s1" })` then `useSessions.getState().beginTurn("s1")` (both patterns already in that file, e.g. `:498`):
  - `beginTurn` + type into the textarea + Enter → `sendPrompt` NOT called, the composer is empty, and `useQueuedPrompts.getState().bySession.s1` has one entry whose `text` is the typed text.
  - Locked + empty draft + Enter → no `sendPrompt`, no queue entry.
  - Locked + a marker-only draft and no attachments + Enter → no queue entry.
  - Locked + `/compact` + Enter → no queue entry, and `addSystemLine` landed a line. Assert `toMatchObject({ kind: "agent-text", text: "/compact runs when this turn ends — try again then." })` — `addSystemLine` routes through `applySessionUpdate`'s `agent_message_chunk` arm (`src/store/sessions.ts:1476-1481`), so the row's kind is **`agent-text`, NOT `system`**. The existing `/compact` test at `ChatStream.test.tsx:6465-6471` pins the same fact and also asserts the `client:` messageId prefix — assert an assertion on that kind cannot pass, so do not write one.
  - Locked + a staged attachment + text + Enter → the queue entry carries the attachment, `URL.revokeObjectURL` was NOT called, and the composer's strip is empty.
  - Not locked → `sendPrompt` is called and nothing is enqueued (the regression pin).
- [ ] Run `pnpm test src/components/ChatStream.test.tsx`
  - Do the new tests fail with "expected sendPrompt not to have been called" / undefined queue entry? If they passed already, the guard is not where the plan says — re-read `:873-890`.
- [ ] Implement the fork.
- [ ] Run `pnpm test src/components/ChatStream.test.tsx`
  - All green including the baseline set? Fix before continuing.
- [ ] Do NOT run `npx tsc --noEmit` or the full suite here — a sibling owns other files in wave 2; the orchestrator runs both after the wave.
- [ ] Commit: `feat: queue prompts sent while a turn is in flight`

**Acceptance criteria:**
- [ ] A locked Enter enqueues exactly one entry, empties the composer, and calls no IPC.
- [ ] `/compact` mid-turn produces the system line and enqueues nothing.
- [ ] Attachments are moved, never revoked, and an unlocked send is unchanged.

---

### Task 4: The queue row components

**Parallel:** wave 2 — disjoint from Task 3 (`src/components/ChatStream.tsx`, `src/components/ChatStream.test.tsx`); imports Task 1's store only.

**Context:**
Each **Queued prompt** renders as one thin **queue row** in the island column between the transcript and the composer — in-flow, never floating, so nothing it renders can cover a **Gate** card or the streaming answer. The composer island is `relative m-1 shrink-0 rounded-xl bg-composer p-3` (`src/components/chat/ComposerRow.tsx:129`) and is a SIBLING of `<main>` in `ChatStream`'s return, so the row inherits the island family by reusing those classes one step thinner. `bg-composer` is deliberate: it is the token the **response band** and composer wear, so a queue row reads as the user's surface — and it means **no new colour token**, which matters because `src/lib/paletteCompleteness.test.ts` fails a token a **Palette** does not restate.

Exit direction must differ by cause (sent → up into the transcript; deleted → right, out), and the row must still be in the DOM while it animates. So the exit is driven by the `leaving` field on `animate`, NOT by removing the child and letting `AnimatePresence` replay it: the row calls `forget(id)` when its animation completes. Reduced motion must call `forget` on the same tick, or a row strands forever.

The row's Esc must not reach `ChatStream`'s window-level listener (`ChatStream.tsx:347-355`), which sends `session/cancel` while `inTurn` — precisely when rows are on screen. `TranscriptFooter`'s `gate-row` wrapper is the existing stop-propagation pattern.

**Files:**
- Create: `src/components/chat/QueueRow.tsx`
- Create: `src/components/chat/QueueRows.tsx`
- Test: `src/components/chat/QueueRow.test.tsx`
- Test: `src/components/chat/QueueRows.test.tsx`

**What to implement:**

`QueueRows.tsx`
```tsx
export default function QueueRows({ sessionId }: { sessionId: string }) { /* ... */ }
```
Infer the return type — no component in `src/components/` annotates one (`TranscriptFooter.tsx:30` is the house shape), and `JSX.Element` needs a namespace import here for nothing.
- Read the list with `const raw = useQueuedPrompts((s) => s.bySession[sessionId]);` — the selector returns the array or `undefined`, never a fresh `[]` (a selector whose result is a new reference every call makes Zustand re-render forever; the rule is stated at `ChatStream.tsx:80-81` and in `useSessionStatus.ts:82`).
- Render `null` when `(raw?.length ?? 0) === 0` — the gate is the TOTAL entry count, not `livePrompts(raw)`. A row's exit is the `leaving` field on `animate` plus `forget()` in `onAnimationComplete`, so a row must stay MOUNTED to finish leaving; gating on the live count flips the stack to `null` on the same render `markLeaving`/`takeHead` lands for the last live row, cancelling its animation and never calling `forget` (a stranded `leaving` entry then repaints as an invisible band when a later `enqueue` re-mounts the stack). `livePrompts` stays the UI read for COUNTING queued prompts — it is simply not the unmount gate; the stack collapses on its own because `forget` deletes the `bySession` key when the last entry is removed.
- Otherwise `<AnimatePresence initial={false} mode="popLayout">` around one `QueueRow` per entry of `raw` (ALL entries, including leaving ones — they are the ones animating out), keyed by `prompt.id`, in array order: head first (top, nearest the transcript), newest last (bottom, nearest the composer).

`QueueRow.tsx`
```tsx
export default function QueueRow({
  sessionId,
  prompt,
}: {
  sessionId: string;
  prompt: QueuedPrompt;
}) { /* ... */ }
```
- Container: `m-1 shrink-0 rounded-xl bg-composer px-3 py-1.5`, wrapped in `motion.div` with `layout`, `initial={{ opacity: 0, y: 14 }}`, and `animate` chosen from `prompt.leaving`: `"sent"` → `{ opacity: 0, y: -28 }`, `"deleted"` → `{ opacity: 0, x: 160 }`, otherwise `{ opacity: 1, y: 0, x: 0 }`. `onAnimationComplete={() => { if (prompt.leaving) forget(sessionId, prompt.id); }}`.
- **Reduced motion:** guard the read with `typeof window.matchMedia !== "function"` — the idiom at `src/lib/theme.ts:16` and `src/components/QueuedSummaryContent.tsx:65`. Do NOT copy `src/components/ui/braille-loader.tsx:29-30`'s `"matchMedia" in window` test: in this jsdom the property EXISTS but is `undefined` (verified — `"matchMedia" in window === true`, `typeof window.matchMedia === "undefined"`), so that guard passes and the call throws. When it matches, render a plain `div` (no motion) and in a `useEffect` call `forget` immediately if `prompt.leaving` is set. A `motion` exit that never fires in reduced-motion would otherwise leave the entry `leaving` and the row stuck.
- **Which branch renders is read from the store, not local state:** `prompt.state === "editing"` selects the editor and `setEditing(...)` selects the display row. The editor's TEXT is local `useState` (below) — only the flag is shared. Keeping the FLAG in the store is load-bearing, not tidiness: it is what lets `takeHead` know an entry is mid-edit (see the rule in Task 1), which a row-local `useState` could not express.
- Display state: a `<span>` with `text-ui-xs text-foreground-subtlest` reading `Queued` — its OWN element, never `"Queued: "` concatenated with the text, so selecting the row does not drag the label — then the text in `text-ui-sm text-foreground` with `truncate` on a single line. Attachments, if any: one `Paperclip`-style icon plus the count (import from `lucide-react`; `AttachmentStrip` already imports `X` from it, so the dependency is present) — no thumbnails in the thin row.
- Right cluster: `ml-auto flex shrink-0 items-center gap-1` holding a pencil and a trash button (`PencilIcon` / `TrashIcon`, `size-3.5`, the house size used at `src/components/settings/McpSection.tsx:172,182`), each a `<Button type="button" variant="ghost" size="icon-sm">` (from `../ui/button`) wrapping the icon with `className="size-3.5"` — the exact idiom at `src/components/settings/McpSection.tsx:165-172`, including why the icon's own `size-3.5` survives the button variant's `[&_svg:not([class*='size-'])]:size-3` rule (the svg already carries a `size-` class, so the variant leaves it alone). Give each an `aria-label`: `Edit queued prompt` / `Delete queued prompt`. ALWAYS visible, never hover-revealed: a queue row is a control, not a **Transcript row**. The `shrink-0` is `WorkingIndicator`'s lesson — an unshrinkable text sibling otherwise squeezes the hit targets at the default 800px window.
- The row body (label + text) is a `button` (or a `div role="button" tabIndex={0}` with Enter/Space) that calls `setEditing(sessionId, prompt.id, true)`; the pencil calls the same. The trash calls `markLeaving(sessionId, prompt.id, "deleted")`.
- Editing state: a `textarea` with `w-full resize-none bg-transparent text-ui-sm outline-none`, `autoFocus`, `rows={3}`, seeded from `prompt.text` in local `useState`, plus `Save` and `Cancel` buttons. Enter saves, Shift+Enter inserts a newline, and the keydown handler calls `e.stopPropagation()` on `Escape` after `setEditing(..., false)` — with a comment naming the window listener this protects against.
- `Save` calls `updateText(sessionId, id, next)` then `setEditing(..., false)`. `Save` is `disabled` when `next.trim() === "" || draftIsMarkerOnly(next.trim())` (`draftIsMarkerOnly` from `../../lib/chatAttachments`) — an empty edit is refused, never silently deleted. `Cancel` discards and leaves the entry as found. Saving a `failed` entry routes through `updateText`, which clears `failed` (Task 1) — so a failed row becomes sendable again by saving an edit of it — there is no separate retry button and no `clearFailure` action.
- A `failed` entry is rendered like any other row plus a `text-destructive` marker (the word `Failed` in the label span's slot, or the label recoloured) — it is LIVE state the user has to be able to see, because it will never send by itself. No new token: `text-destructive` is an existing status colour.
- While editing, show `AttachmentStrip` (from `./AttachmentStrip`) for the entry's attachments, and wire its remove to a handler that calls `removeAttachment(sessionId, id, attachmentId)` AND rewrites the local text with `renumberImageMarkers(text, position)` where `position` is the 1-based index computed BEFORE the filter — the exact rule `ChatStream`'s own `removeAttachment` uses at `:945`.
- **Import specifiers from `src/components/chat/` go two levels up**: `../../lib/chatAttachments` and `../../store/queuedPrompts` (compare `AttachmentStrip.tsx:1-2`). `../lib/...` resolves to `src/components/lib/`, which holds only `transcriptRow.ts` and `utils.ts` — Vite would fail to resolve before a single component rendered.
- No `$` / `@` / `?` / `#` picker inside the inline editor. Those characters edit as raw text; **Mention** expansion happens later, at send. State this as a comment, not a bug.

Do NOT: add reordering handles, a "send now" button, a max-height scroll container, new colour tokens, or any `useSessions` read.

**Steps:**
- [ ] Write `QueueRow.test.tsx`: the label renders as its own element and the text is present; clicking the body enters edit (the textarea appears with the text); clicking the pencil does the same; Escape inside the textarea leaves edit AND stops propagation (assert with an outer `onKeyDown` spy on a wrapper div); Save is disabled for `""` and for `[image #1]` with no attachments; Save writes the new text to the store; trash sets `leaving: "deleted"`; with `matchMedia` stubbed to `matches: true`, trash calls `forget` immediately (the store loses the entry) — stub it the way `src/components/ui/braille-loader.test.tsx:16-37` does. `QueueRows.test.tsx` renders rows too, so it needs the same stub — `ChatStream.test.tsx:150-160` is the in-repo copy of that stub and its comment explains why jsdom needs it.
- [ ] Write `QueueRows.test.tsx`: `null` for `undefined`, `[]`, and a list whose every entry is leaving; one row per live entry in array order with the head first; the container carries `bg-composer` and no other background class (the palette pin).
- [ ] Run `pnpm test src/components/chat/QueueRow.test.tsx src/components/chat/QueueRows.test.tsx`
  - Failed on the missing modules? If they passed, stop — the components already exist.
- [ ] Implement both components.
- [ ] Run `pnpm test src/components/chat/QueueRow.test.tsx src/components/chat/QueueRows.test.tsx` — green.
- [ ] Do NOT run `npx tsc --noEmit` or the full suite here — a sibling owns `ChatStream.tsx` in wave 2; the orchestrator runs both after the wave.
- [ ] Commit: `feat: add the queue row stack`

**Acceptance criteria:**
- [ ] Both files render in isolation against a store fixture.
- [ ] Body click and pencil click both enter edit; Escape does not bubble.
- [ ] Every exit path ends in `forget`, including reduced motion.
- [ ] The row uses `bg-composer` and introduces no new colour token.

---

### Task 5: Mount the stack and Flush the head when the Session goes idle

**Parallel:** none — modifies `src/components/ChatStream.tsx` and `src/components/ChatStream.test.tsx`, shared with Tasks 3 and 6.

**Context:**
Two pieces join here: the stack mounts as the third island between `</main>` and `<ComposerRow>`, and the **Flush** fires when the **Session** stops being busy.

**The trigger is the falling edge of a COMPOSITE busy flag, not of `inTurn`.** `composerLocked` (`:222`) is `workingOrInTurn || agentState === "blocked" || compacting !== undefined`, and Task 3 enqueues during ALL THREE. An **idle** compaction emits no `turn_start` / `agent_settled` — the file says so at `:165-169` — so `inTurn` stays `false` for the whole of it. A trigger keyed on `inTurn` alone would queue a prompt during a `/compact` and then never fire: the row would sit until the user happened to send something else. So the predicate is `busy = workingOrInTurn || agentState === "blocked" || compacting !== undefined` — literally `composerLocked`, which is what the queue fork keys on, so enqueue and **Flush** agree by construction.

**The Flush covers the VISIBLE Session only** (correction 1 in the header): `sendText` expands **Mentions** through catalogs keyed on the ACTIVE **Session**'s Space (`:442-445`), so a background **Session**'s prompt would expand against the wrong **Space**. A background queue holds until it is visible AND goes idle.

**Three traps this task must not ship:**

1. **A self-inflicted retry loop.** `sendText` runs `beginTurn` before `sendPrompt` throws, so a failed **Flush** makes `busy` fall `true → false` — its own falling edge. Requeueing on that edge re-sends immediately: a hot loop against the backend. The fix is NOT a "flush in progress" ref (the `finally` clears it before React runs the effect, so the guard has already lapsed by the time it is read). The fix is that a failed entry is **marked**: `takeHead` skips it, so the edge it caused finds nothing to send. The prompt stays visibly queued and becomes retryable only by a user action — which is what "a persistent failure leaves a stuck-but-visible queue" actually requires.
2. **A leaking object URL.** Task 1's `forget` deliberately does NOT release attachments for a `"sent"` entry. The owner of those URLs is the DISPATCH path (`send()` releases `heldForSendRef` at `:1118-1122`), so `flushHead` must release `entry.attachments` itself on success, or a successfully-sent attachment leaks until the Session closes.
3. **A capability bypass.** `send()` fail-closes on `imageCapable` twice (`:871` and `:947`, "a same-session capability regression must not ship images to an agent that can't take them"). The queue path must re-derive it the same way at send time.

**Files:**
- Create: `src/hooks/useSessionIdleEdge.ts`
- Create: `src/hooks/useSessionIdleEdge.test.ts`
- Modify: `src/components/ChatStream.tsx`
- Test: `src/components/ChatStream.test.tsx`
- Modify: `CONTEXT.md`

**What to implement:**

`useSessionIdleEdge.ts` — a hook this narrow is worth naming for what it detects rather than what it does:
```ts
export function useSessionIdleEdge(opts: {
  /** The composite busy flag — pass `composerLocked` verbatim. */
  busy: boolean;
  /** Fired when `busy` falls, and NOT for an edge this session caused by flushing. */
  onIdle: () => void;
}): void { /* ... */ }
```
- `const cb = useRef(opts.onIdle); cb.current = opts.onIdle;` — assigned DURING RENDER, so the closure the edge fires is always the current one. Say so in the doc comment: it is why the caller passes a fresh inline function instead of a `useCallback` with a guessed dep array.
- One `useEffect` on `[busy]`: `const was = seen.current; seen.current = busy;` then fire ONLY when `was === true && !busy`.
- `const seen = useRef<boolean>(busy);` — seeded with the value at mount, so the FIRST render of a **Session** that is already idle is not an edge, and neither is `ChatStream`'s remount (the Settings view unmounts it wholesale, `App.tsx:424-425`, and a ref reset re-seeds from the current `busy`). This per-component seeding is correct precisely because the Flush is visible-Session-only: there is no cross-Session memory to preserve, and no module-level map is needed.
- Because the flag is one boolean about the VISIBLE Session, a session switch is not itself an edge — switching to a **Session** that settled while hidden does NOT flush, and that is the honest behaviour. Say it in the hook's comment and do NOT promise otherwise.
- **One residue, accepted and shared with the composer.** The store does NOT reset `agentState` on `turnCompleted` (the file says so at `:157-159`), so a **Session** left `blocked` by an unresolved **Gate** keeps `composerLocked` — and therefore `busy` — true indefinitely, and its queue never drains. That is exactly today's behaviour for the Send button (a locked composer cannot send either), so the queue inherits a pre-existing condition rather than creating one. Fixing it would mean clearing `agentState` in `turnCompleted`, which is a composer change outside this plan needing its own reasoning. Note it in the hook's comment as a known non-flush, and do NOT add a timer or a force-flush to work around it.
- Do not use `useCallback` anywhere in this task.

In `ChatStream.tsx`, `flushHead` (a plain `const` arrow function, declared AFTER `sendText` and `send` so it closes over them):
```ts
const flushHead = async () => {
  const sessionId = activeSessionIdRef.current;
  if (!sessionId || sendingSessionsRef.current.has(sessionId)) return;
  const entry = useQueuedPrompts.getState().takeHead(sessionId);
  if (!entry) return;   // an empty or all-failed queue lands here
  sendingSessionsRef.current.add(sessionId);
  try {
    // Fail-closed on capability exactly as send() does at :871. `imageCapable`
    // is the render-derived value and `flushHead` is a fresh closure every
    // render, so it is current — the re-derivation at :947 exists only because
    // a resume can happen MID-send, and the Flush never resumes anything.
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
    // The dispatch path owns these URLs: Task 1's `forget` refuses to release a
    // "sent" entry precisely because the sender does. Nothing after this point
    // can put them back in a row.
    const stopReason = await sendText(sessionId, entry.text, images, () => {});
    entry.attachments.forEach(releaseAttachment);
    if (stopReason === null) return;   // unreachable from this caller — see below
    turnCompleted(sessionId, stopReason);
  } catch (err) {
    turnCompleted(sessionId, "end_turn");
    // Restore the head AND mark it failed. `leaving` clears so its row stops
    // animating out, its object URLs were never revoked so the preview is still
    // valid, and `failed` is what stops the idle edge that `turnCompleted` just
    // caused from re-sending it.
    useQueuedPrompts.getState().requeueHead(sessionId, { ...entry, leaving: undefined, failed: true });
    if (activeSessionIdRef.current === sessionId) setError(describeIpcError(err));
  } finally {
    sendingSessionsRef.current.delete(sessionId);
  }
};
```
- **The `images` argument.** `sendText` takes the id-bearing reconciled shape (Task 2). Task 2 must `export type SendTextImages = { id: string; name: string; mimeType: string; sizeBytes: number; data: string }[]` from `ChatStream.tsx`'s own module scope (declare the alias ABOVE the component and use it in `sendText`'s signature, so Task 5 and `send()` share one spelling rather than restating an inline literal twice). Annotate the mapped array with it — the annotation is what makes `tsc` catch a stray `file` / `filename` key that would ship a `File` over IPC.
- **The `onCommitted` argument.** The Flush has no composer, so it passes `() => {}` — an empty callback with a comment saying why. Do not "improve" this by making `onCommitted` optional; Task 2's signature has `send()` needing it and an empty function is clearer than an optional one.
- **`stopReason === null`** cannot be reached from this caller (it passes `undefined` or a non-empty array), so the guard is a type-exhaustiveness branch with NO test — comment it as such so nobody reads it as covered or deletes it as noise.
- **Why the `failed` marker and not a flush-in-flight ref.** The self-inflicted edge fires AFTER `flushHead`'s `finally` has run, so no ref cleared in that `finally` can still be `true` when the hook reads it. `failed` is durable state instead of a timing window, and it gives the right user behaviour for free: the failed prompt stays on screen, and editing it (`updateText` clears `failed`) makes it sendable again. One consequence worth knowing: when the head fails, the edge it causes moves on to the NEXT non-failed entry, so one broken prompt does not stall the ones behind it.
- Wire the hook in TWO parts, because `ChatStream` has a mid-body early return at `:852` (`if (!activeSessionId) { return … }`) and this file warns FOUR times (`:226`, `:252`, `:265`, `:276`) that a hook called only on the full-frame path changes the hook count and white-screens the app. Part 1, immediately BEFORE `:852` alongside the other unconditional hooks:
  ```ts
  // BEFORE the `!activeSessionId` early return: a hook after it is a
  // conditional hook call. `composerLocked` is in scope above, and the Flush's
  // real body lives below next to `sendText`, reached through this ref.
  const flushRef = useRef<() => void>(() => {});
  useSessionIdleEdge({ busy: composerLocked, onIdle: () => flushRef.current() });
  ```
  Part 2, a plain assignment (not a hook) after `flushHead`:
  ```ts
  flushRef.current = () => {
    void flushHead();
  };
  ```
  This is the same render-phase ref mirror the file already uses for `attachmentsRef` (`:289`), `activeSessionIdRef` (`:303`) and `draftRef` (`:310`). Note in the comment that a discarded concurrent render can leave its closure in the ref and the next render re-assigns it — harmless here, and worth saying because it is the one thing a reader of a render-phase write will worry about.
- Mount `<QueueRows sessionId={activeSessionId} />` between the closing `</main>` and `<ComposerRow>` (the return begins `:1534`). `main`'s `min-h-0` stays untouched (its comment says it is load-bearing); the rows are `shrink-0` siblings.
- Leave the unmount cleanup (`:317-329` — NOT `:807`, which is the `archimedes:insert-skill` listener) ALONE: it releases the composer's staged list and `heldForSendRef` only. Queue attachments belong to the store, which outlives `ChatStream` (the Settings view unmounts it), so releasing them there would break a surviving queue's previews.
- Fix **two** `CONTEXT.md` entries, both of which describe the trigger as "when that turn settles" — true for a finished turn, false for the idle compaction and the `blocked` **Gate** cases the composite flag also covers:
  - **Prompt queue** claims "a background **Session**'s queue keeps draining while it is off screen". Replace with: drained when it is the VISIBLE **Session** and that **Session** stops being busy; held while off screen, draining only once it is on screen again and idle.
  - **Flush** says "the moment that **Session**'s turn settles — one per settle". Replace with: the moment that **Session** stops being busy (the same composite lock the composer refuses on), one per such edge.
  Keep the rest of both entries, and keep **Flush**'s `_Avoid_` line — `drain` still names the harness's opposite act.

**Steps:**
- [ ] Write `useSessionIdleEdge.test.ts` (`renderHook`): first render with `busy: false` fires nothing; `false → true → false` fires once; two consecutive edges fire twice; remounting with `busy: false` fires nothing (the seed pin).
- [ ] Run `pnpm test src/hooks/useSessionIdleEdge.test.ts` — fails on the missing module; implement; green.
- [ ] Write the `ChatStream.test.tsx` cases: a queued entry + the **Session** going idle → `sendPrompt` called with the entry's text, EXPANDED where a `$skill` token is present (reuse the file's existing **Mention** fixtures so the assertion proves `sendText` was reached); a second idle fires the second entry; **`sendPrompt` rejecting puts the entry back at the head with `failed: true` and leaves the `sendPrompt` call count at EXACTLY 1** (the no-retry-loop pin — assert the count, not just the requeue), and a subsequent idle edge still does not re-send it; editing it and going idle again DOES; a prompt queued during an idle compaction (`useSessions.setState({ compacting: { s1: "manual" } })` → back to `undefined`) flushes; a queue entry with an attachment whose flush succeeds releases the object URL; a flush where `agentSupportsImages` is false sends text-only (the 2-arg `sendPrompt`); rendering `ChatStream` with no active session does not crash (the hook-count pin); the stack renders between `main` and the composer by DOM order (`data-testid="queue-rows"`).
- [ ] Run `pnpm test src/components/ChatStream.test.tsx` — fails before implementing, green after.
- [ ] Run `pnpm test` (FULL suite) and `pnpm build` — this is the first serial point after wave 2, so the whole-suite run belongs here.
- [ ] Commit: `feat: flush the prompt queue when the session goes idle`

**Acceptance criteria:**
- [ ] `useSessionIdleEdge` is called BEFORE the `!activeSessionId` early return; no-session render does not crash.
- [ ] A busy→idle fall sends the head, including after an idle compaction.
- [ ] A failed Flush restores the head as `failed` and sends **exactly once** — no retry loop; editing the failed row makes it flushable again.
- [ ] A successful Flush releases its attachments; a capability regression sends text-only.
- [ ] Both `CONTEXT.md` entries (**Prompt queue** and **Flush**) describe the composite idle trigger and the visible-Session rule.

---
### Task 6: Un-gate drag-and-drop and the `+` picker during a turn

**Parallel:** none — modifies `src/components/ChatStream.tsx` and `src/components/ChatStream.test.tsx`, shared with Tasks 3 and 5.

**Context:**
The three attachment staging paths disagree about `composerLocked` today, and the queue makes the disagreement visible: clipboard paste (`ChatStream.tsx:1324`) has NO `composerLocked` check and already stages mid-turn, while drag-and-drop (`:1383`) and the `+` picker (`:1396`, plus the button's `disabled` at `ComposerRow.tsx:303`) both refuse. So a user who pastes a screenshot mid-turn and then queues a text prompt leaves the image stranded in the composer while the words go. Un-gating the two paths makes all three consistent and makes "attachments queue with the text" true for every route.

`imageCapable` stays as the gate on all three paths, fail-closed and unchanged — it is the capability check, not the turn check. `composerEnabled` also stays on the picker (a session that cannot be sent to must not accumulate images).

**Files:**
- Modify: `src/components/ChatStream.tsx`
- Modify: `src/components/chat/ComposerRow.tsx`
- Test: `src/components/ChatStream.test.tsx` — **this task INVERTS two existing assertions.** They pin the behaviour being removed, so they must change; unlike Task 2, where "tests untouched" is the criterion.

**What to implement:**
- `handleDrop` (`:1382-1386`): `if (composerLocked || !imageCapable) return;` → `if (!imageCapable) return;`.
- `handleAttachClick` (`:1396`): `if (!composerEnabled || composerLocked || !imageCapable) return;` → drop the `composerLocked` term.
- `ComposerRow.tsx:303`: the `+` button's `disabled={!composerEnabled || composerLocked || !imageCapable}` → `disabled={!composerEnabled || !imageCapable}`. Update its comment (it currently says "disabled while the composer is locked"), and keep the Send button's `disabled` untouched — Send must stay disabled during a turn because Enter reaches `send()`, which now enqueues.
- Add a comment at `handleDrop` naming the invariant: staging is allowed during a turn on all three paths, and a locked Enter moves the staged set into the queue row.
- **Invert these two existing tests** — both are real, both are in this file, and both fail the moment the above lands:
  - `:1575` `"the `+` button is disabled while a turn is in flight (the composer is locked)"` → retitle to `"the `+` button STAYS enabled while a turn is in flight (staging is allowed; only Send locks)"`, assert `hasAttribute("disabled")` is `false`.
  - `:1849` `"drop is ignored while locked"` → retitle to `"drop STAGES while locked"`, assert `queryByAltText("d.png")` is NOT `null`.
  Change NOTHING else in the file. Both pins survive, pointed the other way: the old behaviour was deliberate, and it is now deliberately reversed.

**Steps:**
- [ ] Write failing tests in `ChatStream.test.tsx`: with `beginTurn("s1")` and an image-capable session, `fireEvent.drop` on the composer stages a thumbnail; clicking the `+` button calls the dialog and stages. Then: drop an image while locked, queue a text-only prompt, and assert the queue entry carries that attachment and the composer's strip is empty.
- [ ] Run `pnpm test src/components/ChatStream.test.tsx` — the new cases fail.
- [ ] Apply the three removals.
- [ ] Run `pnpm test src/components/ChatStream.test.tsx` — green.
- [ ] Commit: `feat: allow staging attachments while a turn is in flight`

**Acceptance criteria:**
- [ ] Paste, drop and `+` all stage during a turn, and exactly the two named assertions above were inverted — no other test in the file changed.
- [ ] A staged image queues with the next prompt instead of being stranded.
- [ ] Send stays disabled during a turn, and `!imageCapable` still blocks all three paths.

---

### Task 7: Clear the queue when a Session closes

**Parallel:** none — it runs last by choice, not by necessity: its files (`src/lib/sessionLifecycle.ts`, `src/store/sessions.ts`, `src/lib/sessionLifecycle.test.ts`) are disjoint from every other task's, so it could have joined a wave. It is serial because it is the plan's exit gate (the only task that runs the full `cargo` bar), and the exit gate runs alone.

**Context:**
ADR 0069 requires `closeSession` to clear the **Session**'s queue for the same reason `handleSessionClosed` already clears `stalled` and `compacting` (`src/store/sessions.ts:1666-1674`): a reopened **Session** must not offer a **Flush** whose turn can never arrive. The existing seam is `onSessionClosed` in `src/lib/sessionLifecycle.ts`, which already fans the close out to `useInteractive`, `usePermissions` and `useSessions` — the queue joins that list and nothing else.

**Files:**
- Modify: `src/lib/sessionLifecycle.ts`
- Modify: `src/store/sessions.ts` (`deleteSession`)
- Test: `src/lib/sessionLifecycle.test.ts`

**What to implement:**
- Import `useQueuedPrompts` from `../store/queuedPrompts` and call `useQueuedPrompts.getState().clearSession(sessionId);` alongside the existing `dismissSessionPrompts` line, with a one-line comment naming ADR 0069's reason.
- **Also clear it in `deleteSession`** (`src/store/sessions.ts:1132-1152`). A close has `onSessionClosed` to fan out through; a DELETE does not — `deleteSession` drops the row from all three lists and sets `activeSessionId: null`, so the **Session** is unreachable, its rows never render, `forget` never runs, and its object URLs are held by nothing but released by nothing. One `useQueuedPrompts.getState().clearSession(sessionId)` after the `await deleteSessionCommand(...)`, next to the existing `applyTodoClear` call. Without it every deleted **Session** leaks its queued attachments for the process lifetime.
- Add NO confirm dialog and no persistence. Closing a live **Session** already confirms elsewhere; this is the cleanup, not a gate.

**Steps:**
- [ ] Add a `beforeAll` URL stub to `src/lib/sessionLifecycle.test.ts` first (`URL.createObjectURL = vi.fn(...)` / `URL.revokeObjectURL = vi.fn()`, the `chatAttachments.test.ts:5-8` shape) — that file has none today, and Node's real `revokeObjectURL` accepts any string silently, so an assertion on it would be unprovable.
- [ ] Write a failing case: seed `useQueuedPrompts` with two entries for `"s1"` (one with an attachment), call `onSessionClosed("s1", "user")` (`CloseReasonStr` is `"user" | "agent-exited" | "error"` — `src/lib/tauri.ts:85` — NOT `"closed"`), and assert `bySession.s1` is gone AND `URL.revokeObjectURL` ran for the attachment. Add a second case for `deleteSession` clearing the same key.
- [ ] Run `pnpm test src/lib/sessionLifecycle.test.ts` — fails.
- [ ] Add the call; re-run until green.
- [ ] Run `pnpm test` (full suite) and `pnpm build` — both green. This is the plan's exit gate.
- [ ] Run `cargo test`, `cargo clippy --all-targets`, `cargo fmt --check` from `src-tauri/` — required by AGENTS.md's unconditional bar; all must be green UNCHANGED (no `.rs` file is in this plan, so a red here is an unrelated breakage).
- [ ] Commit: `feat: clear the prompt queue when a session closes`

**Acceptance criteria:**
- [ ] Closing a **Session** empties its queue and releases its attachments.
- [ ] No other store's close behaviour changed.
- [ ] `pnpm test`, `pnpm build`, and the three `cargo` checks are green.

---

## Out of scope

- No Rust change of any kind: no `send_prompt` relaxation, no protocol command, no harness queue touched (ADR 0069).
- A **Subagent session** gets no queue — it has no composer, and its gates render inline in the parent's transcript.
- The queue does not survive a reload or app quit; it has the composer draft's lifetime.
- No **Mention** / **File completion** picker inside the inline editor (Task 4 states the limit in code).
- No reordering of queued prompts, no "send now" bypass.
