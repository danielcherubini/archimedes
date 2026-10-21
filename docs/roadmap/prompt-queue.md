---
status: approved
issue: https://github.com/danielcherubini/archimedes/issues/74
done-when: With a turn in flight on a live Session, typing in the composer and pressing Enter leaves the composer empty, drops a `Queued: …` row into the stack between the transcript island and the composer, and sends that text as an ordinary turn the moment the current one settles; the row's pencil re-edits it in place and its trash removes it, and neither action requires the turn to end first. `pnpm test` and `pnpm build` are green (no Rust file is touched, so `cargo test` / `clippy` / `fmt` are in the bar only because AGENTS.md's bar is unconditional).
---

# Send while inference runs: the Prompt queue

## Problem

Sending a prompt while a **Session**'s turn is in flight does nothing. Two layers refuse it independently:

- `src/components/ChatStream.tsx:222` — `composerLocked = workingOrInTurn || agentState === "blocked" || compacting !== undefined`, and `send()` returns early on it (`:885`). Enter and the Send button are inert for the whole turn.
- `src-tauri/src/agent/session/mod.rs:1407` — `send_prompt_with_images` makes an atomic `pending_turn` claim and returns `Err("a turn is already in flight")` if the slot is occupied.

The textarea is editable during a turn (drafting is preserved), but the words have nowhere to go. A person mid-turn who thinks of the next thing either waits, or types it and loses it.

A reader of the Rust side will find `AgentLoop`'s `prompt_queue` (`src-tauri/src/agent/harness/loop.rs:361`) and conclude the plumbing already exists. It does not behave as a queue for user input: the **Supervisor** refuses a mid-turn prompt before it is ever written, and `cancel_turn` **drains** it, discarding whatever is in there (`:516`) — a Stop is specified to throw it away. See ADR 0069 and the **Harness prompt queue** glossary entry; this feature's queue is a different thing in a different process.

## What is being built

Prompts sent during a turn enter a per-**Session** **Prompt queue** held by the renderer. Each entry renders as a thin **queue row** in the island column between the transcript and the composer, wearing the composer's own tokens. Each row is editable in place and deletable. When the **Session**'s turn settles, the head of its queue is **Flush**ed — sent as an ordinary `send_prompt`, indistinguishable from a manual send at every layer below the composer.

Nothing floats and nothing overlays. The rows consume real height and the transcript shrinks to accommodate, exactly as the composer island already does.

## Design

### 1. Language (in `CONTEXT.md`)

Five terms, already captured: **Prompt queue**, **Queued prompt**, **Flush**, **Queue row**, **Harness prompt queue**. Two of them exist to defuse collisions that would otherwise bite a future reader:

- **Harness prompt queue** names `AgentLoop`'s Rust queue, whose `drain` is the *opposite* act of our **Flush** — it discards.
- **Queue row** replaces an earlier draft entry, **Queue bubble**, which described a floating surface this feature does not have.

The queue is deliberately **absent from `sessionStatusOf`** (`src/hooks/useSessionStatus.ts:36`), the one status rule feeding the row pill, the rail mark and both **Attention alert** triggers. A non-empty queue means the user has more to say; it never means the **Agent** is parked on the user. It must not feed a status pill or raise an **Attention alert**.

### 2. State: `src/store/queuedPrompts.ts`

A new store, not a section of `sessions.ts` (1686 lines, with a 4155-line test file). The precedent for a small per-surface store keyed by `sessionId` is `permissions.ts` (58 lines) and `interactive.ts` (226 lines).

```ts
interface QueuedPrompt {
  id: string;                                  // client-minted: React key + edit/delete handle
  text: string;                                // the RAW draft — never Mention-expanded
  attachments: ChatComposerAttachment[];       // moved out of the composer, not copied
  state: "queued" | "editing";
  leaving?: "sent" | "deleted";                // set at exit, cleared by forget()
}

interface QueuedPromptsState {
  bySession: Record<string, QueuedPrompt[]>;   // ordered: index 0 = next to Flush
  enqueue, updateText, removeAttachment, remove, setState, takeHead, forget, clear
  livePrompts: (sessionId: string) => QueuedPrompt[];  // the ONLY read path
}
```

Four rules, each answering a hazard that already exists in the code:

- **`takeHead` is the Flush's only mutation**, and it pops atomically. `ChatStream`'s double-send guard is `sendingSessionsRef` (`:296`), a `Set` keyed by session id that exists precisely because `beginTurn` runs *after* an `await`. The **Flush** goes through that same ref, or a **Flush** racing a manual send double-fires.
- **`livePrompts()` is the only read path.** The exit animation needs a row to survive briefly after leaving, so the store holds it with `leaving` set and the row calls `forget(id)` when its animation completes. Every consumer — `takeHead`, the row count, the "render anything at all" test — reads through `livePrompts` and never the raw array. Reduced motion skips straight to `forget`, or those rows never leave.
- **Object URLs are released at exactly three sites** — **Flush**, delete, unmount — mirroring `AttachmentStrip`'s rule, and never inside a state updater (StrictMode double-invokes it; `ChatStream.tsx:812`).
- **`closeSession` clears the Session's queue**, for the same reason `closeSession` already clears `stalled` and `compacting` (`sessions.ts:1668`): a reopened **Session** must not offer a **Flush** whose turn can never arrive.

Selectors return the map itself, never a fresh `{}` fallback inside the selector — the pinned Zustand infinite-re-render trap that `useSessionStatus.ts:82` warns about.

### 3. The send path: `send()` forks, and both branches share one body

Today: `if (... || composerLocked) return;` — a silent no-op. New: when locked, `enqueue()` instead of returning, except:

| Case | Behavior | Why |
|---|---|---|
| Turn in flight (`workingOrInTurn`) | **Enqueue** | The feature. |
| Compaction running | **Enqueue** | The harness serialises `ControlCmd::Compact` ahead of the next prompt (`loop.rs:545`), so ordering is preserved below us. |
| `agentState === "blocked"` (a **Gate** open) | **Enqueue** | The turn is unsettled, so no **Flush** can fire and the queue is honest about waiting. |
| Draft empty, or marker-only (`draftIsMarkerOnly`) | No enqueue — silent no-op, unchanged | Nothing to queue. |
| A **Composer command** (`/compact`) | **Never queued** — gets an explicit `addSystemLine` instead of today's dead key | ADR 0044's defining act is that a command is *consumed*: nothing is sent, no user row persists. A queue entry's whole contract is "becomes an ordinary `send_prompt`", which a command cannot satisfy. |
| Session not live | Unreachable — the queue engages only while locked | The auto-resume path stays byte-for-byte as today. |

**The structural refactor.** `send()` owns eight things a queued prompt still needs at its own turn — **Mention** expansion, `parseComposerCommand`, the image-capability fail-closed gate, base64 attachment reads, `beginTurn`, `sendingSessionsRef`, the `mergeDedupeKey`-stable text, and the draft wipe. A parallel send path for the queue is where the two would drift, so:

```
send()  → reads draft + staged attachments → sendText(text, attachments)
Flush   → takeHead(sessionId)              → sendText(entry.text, entry.attachments)
```

`sendText` keeps everything from today's `try` block onward. The draft-staleness guards (`draftRef` / `activeSessionIdRef` re-checks, `:985`) stay in `send()` — they exist because the composer is unlocked during the `FileReader` await, a hazard a queue entry does not have.

**Expansion timing is load-bearing.** The store holds the **raw** draft; `expandMentions` runs inside `sendText`. So an edit made after queueing can retarget a `$name` **Mention** and still expand correctly at send, the row displays the token the user typed rather than a 4 KB skill body, and ADR 0031's byte-identity contract holds by construction — the text on the wire is produced by the same call that always produced it.

**Attachments move; they are not copied.** `enqueue` transfers the composer's array into the entry, keeping the existing object URLs, so previews survive the trip. The composer is empty after queueing, which is what makes repeated queueing read as a queue rather than a copy-paste.

### 4. The Flush

Triggered on the **falling edge of `inTurn` per Session** — not inside the store, not during render, and **not only for the active Session** (the queue is per-**Session**, so a background **Session**'s queue drains too). It lives in a subscription that diffs `useSessions`' `inTurn` map by id, mirroring how `useAttentionAlert` detects "the single snapshot where `inTurn` fell" (ADR 0038). One falling edge flushes one entry; the resulting settle edge fires the next.

- **A Stop does not clear the queue** (the decision from ADR 0069), but `turnCompleted("cancelled")` does land on a settle edge, so the next queued prompt starts its turn. Esc means "stop this answer", not "stop my whole plan".
- **First render with `inTurn` already false is not a falling edge.** Pinned by a test: opening a **Session** that has a non-empty queue must not auto-send.
- **A failed Flush re-enqueues at the head**, surfaces `setError`, and does not retry in a loop. `heldForSendRef`'s existing "a failed send puts attachments back" rule (`:283`) is the precedent, so attachments return to the *row*, not the composer. Losing the user's text is the one outcome worse than a stuck queue.

### 5. The queue row stack

New `src/components/chat/QueueRows.tsx` (the stack) and `src/components/chat/QueueRow.tsx` (one row), rendered in `ChatStream`'s return between `</main>` and `<ComposerRow>` — siblings of the same island column, so `main`'s `min-h-0` stays load-bearing and the rows are `shrink-0`.

```
m-1 shrink-0 rounded-xl bg-composer px-3 py-1.5
```

`bg-composer` is the token the **response band** and the composer already wear, so a queue row reads as *the user's surface* — semantically right, and **no new colour token**, because `paletteCompleteness.test.ts` fails on a token a **Palette** doesn't restate and ADR 0062 settled that structural colour is palette-owned. Distinction from the composer comes from thinness and the label, not hue.

- **Content:** a `Queued` label as its own `<span>` (`text-ui-xs text-foreground-subtlest`) rather than `"Queued: "` concatenated with the text, so the message truncates on its own line and selecting the row doesn't drag the label into the selection.
- **Right side:** `PencilIcon` + `TrashIcon` at `size-3.5` (the house size — `McpSection.tsx:172,182`, `ProviderSection.tsx:223`) inside an `ml-auto shrink-0` wrapper. That `shrink-0` is `WorkingIndicator`'s lesson: an unshrinkable text sibling otherwise squeezes the hit targets, and at the default 800px window with both panes open this column gets down to ~108px. The text truncates; the buttons never move or get overprinted.
- **Actions stay visible, never hover-revealed.** A queue row is a control, not a **Transcript row**, and a delete button you can't see is one you don't know you have.
- **Order:** head at the **top** (nearest the transcript), newest at the **bottom** (nearest the composer). A row enters at the bottom near where it was typed, and the row nearest its destination is the one about to send — which makes both exit directions literal.
- **Motion** (`AnimatePresence mode="popLayout"` + `motion`, already a dependency, following `QueuedSummaryContent.tsx`'s house style and its reduced-motion gate): a row enters by rising from the composer with a fade while the rows above slide up to close the gap; a **sent** row exits **upward, into the transcript**; a **deleted** row exits **rightward, out of the column**.

### 6. Editing a queued prompt

Clicking the row body or the pencil swaps the row for a `textarea` in place (the row grows; the composer is never touched, so a half-typed next message is never displaced). `Save` / `Cancel`; Enter saves, Shift+Enter newlines.

- **Esc must `stopPropagation()`.** `ChatStream`'s window-level Esc listener (`:347`) sends `session/cancel` while `inTurn` — exactly when rows are on screen — so editing a queued prompt and pressing Esc would otherwise cancel the **Agent**'s live turn. `TranscriptFooter`'s `gate-row` wrapper is the existing pattern.
- **Empty-after-edit is refused** (Save disabled), including the marker-only case — never silently deleted. An accidental delete is unrecoverable; an empty text is fixable by typing.
- **No mention or file pickers inside the inline editor.** `$` / `@` / `?` edit as raw text. Wiring the picker means porting `activeMentionToken` plus the fetch machinery for marginal gain, and the raw draft still expands correctly at send. A user who wants a picker cancels and edits in the composer instead. Documented limitation, not a bug.

### 7. Attachments

A **Queued prompt** carries **Attachments** with its text. The thin row shows an icon + count; managing them happens in the editing state, where `AttachmentStrip` fits. Removing one there reuses the composer's `renumberImageMarkers` (`ChatStream.tsx:945` — position computed *before* the filter) so **image marker** numbering keeps naming the right picture.

**The three staging paths become consistent.** Today they disagree about `composerLocked`: clipboard paste (`:1324`) is not gated and stages mid-turn already; drag-and-drop (`:1383`) and the `+` picker (`:1396`) both are. This feature makes the inconsistency visible — paste a screenshot mid-turn, then queue a text prompt, and the image is stranded in the composer while the words leave. So **drop and `+` are un-gated during a turn**, matching paste. `imageCapable` still gates all three, fail-closed, unchanged.

### 8. Out of scope

- A **Subagent session** gets no queue — it has no composer, and its gates render inline in the parent's transcript. Stated so nobody builds it by accident.
- The queue does not survive a reload or app quit. Same lifetime the composer draft already has (ADR 0069).
- No persistence, no Supervisor involvement, no new IPC command, no Rust change at all.

## Tests

At the layer CI runs (`pnpm test`, repo root):

1. **Store** — `takeHead` pops atomically and returns `undefined` when empty; `livePrompts()` excludes a `leaving` row; `closeSession` clears.
2. **The `send()` fork** — locked + text enqueues and sends nothing; locked + empty or marker-only enqueues nothing; `/compact` mid-turn emits the system line and enqueues nothing.
3. **The Flush** — a settle edge sends the head through the same path `send()` uses; a second settle sends the second head; a failure restores the head and its attachments; a Stop leaves the queue intact and the next head then flushes; **first render with `inTurn` already false sends nothing**.
4. **The row** — clicking the body and clicking the pencil both enter edit; Esc cancels **without** reaching the window `session/cancel` listener; Save is disabled on empty and on marker-only; trash runs the right-exit then `forget`.
5. **Attachments** — the staged set moves into the row on enqueue; removal in the editing state renumbers markers; a failed **Flush** returns them to the row, not the composer.
6. **Palette** — one assertion that the row wears `bg-composer`, so `paletteCompleteness.test.ts` stays green by construction.

## Files

| File | Change |
|---|---|
| `src/store/queuedPrompts.ts` | new — the queue store |
| `src/store/queuedPrompts.test.ts` | new |
| `src/components/chat/QueueRows.tsx` | new — the stack + the empty check |
| `src/components/chat/QueueRow.tsx` | new — one row, display + editing states |
| `src/components/chat/QueueRows.test.tsx`, `QueueRow.test.tsx` | new |
| `src/components/ChatStream.tsx` | the `send()`/`sendText()` split, the enqueue fork, the Flush subscription, mount the stack, un-gate drop and `+` |
| `src/components/ChatStream.test.tsx` | fork + Flush + un-gating cases |

## Decisions

- **ADR 0069** — the **Prompt queue** is renderer state, and the **Supervisor**'s `pending_turn` one-turn invariant is left exactly as it found it. Rejected: a Supervisor-owned queue riding `AgentLoop`'s `prompt_queue` (every edit/delete would become a protocol round trip, every entry would hold a live resolver, and Stop's drain rule would need re-litigating), and a mirrored both-places design (two owners of one ordered list across a process boundary — the class of bug ADR 0050 exists to settle).
