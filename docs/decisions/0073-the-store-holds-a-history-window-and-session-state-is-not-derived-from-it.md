---
status: accepted
date: 2026-10-20
superseded-by:
---

# The store holds a History window, and session state is never derived from it

> **Renumbered from ADR 0066 on 2026-10-23.** Two decisions were committed on 2026-10-20 under the
> same number: this one (09:53, `a277dd5`) and *Agent overrides live in the store, not the database*
> (20:54, `6969610`, alongside ADRs 0067 and 0068 which cross-reference it by number). **0066 stays
> with the Agent-overrides decision**, on two grounds. Volume: measured at the commit before the
> move, 82 `ADR 0066` occurrences — **69 mean that one, 13 mean this one** (`src-tauri/` 49 of which 7
> are this decision; `src/` 15 of which 4; `docs/` 13 none; `CONTEXT.md` 5 of which 2). And adjacency:
> 0066/0067/0068 were committed as one trilogy in a single commit and reference each other by number,
> so moving the Agent-overrides file would sever those cross-references while moving this one severs
> nothing. No decision changed; only its address.
>
> **The first pass at this move missed the 7 `src-tauri/` sites** (paged history in `commands/history.rs`,
> the `todos_json` migration and updates in `storage/db.rs`, the Supervisor's event-router persistence in
> `agent/persist.rs`) because the sweep grepped `docs/` and `src/` and assumed the Rust hits were uniform.
> They were not — which is the same failure the counts above were written to prevent. If you are here to
> renumber something else, grep the whole tree including `src-tauri/`.

A stored **Session**'s transcript is loaded as a **History window** — the latest 500 display rows, with 200 more prepended per scroll-up page (`load_history` takes `limit` / `beforeId`, cursor = the autoincrement `messages.id`) — and rendered through a virtualized list (`react-virtuoso`). `useSessions.messages[sessionId]` is therefore a *window onto* the transcript, never the transcript. Anything that must be correct regardless of how far the user has scrolled is **session state** with its own storage, and is never recovered by scanning `messages[]`. The first such case is the **Todo board**: its list is persisted in `sessions.todos_json` (written by the **Supervisor**'s event router on a main session's `todos_update` frame, and returned as `todos` on the FIRST page of `load_history`, which seeds `useInteractive.todos` on open / resume), and `useMainTodoItems`' history-scan fallback is deleted.

**Why:** an unbounded `load_history` made load time and draw cost O(session length) — the IPC payload, the `rowToMessages` parse (base64 image attachments dominate) and one DOM subtree per row. Bounding only the render would leave the load cost; bounding only the load would leave a long live transcript unbounded in the DOM. But a windowed store silently breaks every reader that assumed `messages[]` is complete, and the Todo board was the one that mattered: it found the newest `manage_todo_list` write by scanning backwards, so a write older than the window made the board vanish on reload. Making the invariant explicit ("the store is a window") is what stops the next reader from re-introducing the scan.

**Considered Options**

- **Render-only window** (load everything, render the last N): rejected — fixes draw cost and not load time.
- **Return the newest todo row with the first page**: rejected — keeps the board derived from a transcript row, so the fix would be one more special case of the same assumption instead of removing it.
- **A bounded sliding window in the store** (evict the far end as the user scrolls): rejected — a streaming tail cannot be evicted, and the ADR 0050 resume merge would need rework; the DOM is bounded by virtualization either way.

**Consequences**

- **Resume resets the window to the tail.** `resumeSession` reloads the latest 500 rows and merges them with the ADR 0050 identity pass; rows the user had scrolled back to are dropped (a resume comes from a send or the banner, both of which land at the bottom).
- **`titleFor`'s first-user-message fallback sees only the window.** Accepted: a session long enough to be windowed already has a generated title (ADR 0037).
- **The Worker is unaffected.** Its transcript and the Supervisor's rehydration read `native_messages` (`seq`), not the display rows.
- **A one-time migration backfills `todos_json`** from each non-subagent session's newest `manage_todo_list` write row, so stored sessions keep their boards.
- **Auto-scroll is now follow-only-at-bottom.** The old "scroll to the bottom on every store update" cannot coexist with infinite scroll up.
- **This amends one remark of ADR 0041.** That ADR notes that a main session's `rawInput` seed "comes back on purpose" when `applyTodoClear` drops the board's key. The seed — `useMainTodoItems` scanning `messages[]` for the newest `manage_todo_list` write — is deleted, so a clear now leaves the board empty until the next `todos_update`. (`src-tauri/` has never emitted `todos_clear`, so no shipped path changes.) ADR 0041's decision itself — boards are keyed by session id, never by `source` — is untouched.
- **Known, not fixed here:** a resumed session's Worker starts with an EMPTY in-memory `TodoStore`, so a model `add` / `remove` after a resume operates on an empty list. Persisting the board makes seeding that store possible; it is a separate change.
- **Virtualization drops row-local state for rows scrolled far away.** Rows outside the viewport (plus a 600px overscan) are unmounted, so row-local `useState` — a `Reasoning` block's expanded flag and its "Thought for N seconds" timer — is lost when the user scrolls well away and back. Stable identity keys only protect rows that STAY mounted across a prepend. Accepted; lifting that state into the store is a separate change.
- **A send always lands at the bottom, and a streaming reply is followed only while the user is at the bottom.** Virtuoso's `followOutput` reacts to a changed item count and not to a message growing in place, so `MessageList` re-asserts the follow on every tail change; a send scrolls unconditionally.
