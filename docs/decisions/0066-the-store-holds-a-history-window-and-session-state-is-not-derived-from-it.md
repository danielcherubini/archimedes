---
status: accepted
date: 2026-10-20
superseded-by:
---

# The store holds a History window, and session state is never derived from it

A stored **Session**'s transcript is loaded as a **History window** — the latest 500 display rows, with 200 more prepended per scroll-up page (`load_history` takes `limit` / `beforeId`, cursor = the autoincrement `messages.id`) — and rendered through a virtualized list (`react-virtuoso`). `useSessions.messages[sessionId]` is therefore a *window onto* the transcript, never the transcript. Anything that must be correct regardless of how far the user has scrolled is **session state** with its own storage, and is never recovered by scanning `messages[]`. The first such case is the **Todo board**: its list is persisted in `sessions.todos_json` (written by the **Supervisor** on `todos_update` / `todos_clear`, seeded into `useInteractive.todos` on open / resume), and `useMainTodoItems`' history-scan fallback is deleted.

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
