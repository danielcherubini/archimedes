---
status: approved
issue: https://github.com/danielcherubini/archimedes/issues/67
done-when: Opening a 5,000-row session fetches only the latest 500 rows; scrolling up loads 200 more with no scroll jump or lost expanded state; the DOM stays bounded while streaming; the Todo board survives a reload of a session whose last todo write is far outside the window; pnpm test, pnpm build, cargo test, cargo clippy --all-targets (0 warnings) and cargo fmt --check are green.
---

# Paged history window with a virtualized transcript

**Goal.** Opening a long session loads and draws quickly, and chatting in one stays smooth. Decisions and terms: ADR 0066, **History window** in `CONTEXT.md`.

**Chosen approach.** Paged load from SQLite (the latest 500 rows, 200 more per scroll-up page) + `react-virtuoso` for rendering. The store keeps everything it has loaded (monotonic); no sliding window.

## Backend (Rust)

1. `Db::messages_page(session_id, before_id, limit)` returns rows with `id < before_id` in descending order, capped at `limit`, then reversed into transcript order. It fetches `limit + 1` rows to compute `hasMore`.
2. `load_history(sessionId, limit?, beforeId?)` returns `{ rows, hasMore }`. Omitting `limit` and `beforeId` returns everything (existing callers and tests keep working).
3. `sessions.todos_json TEXT` — nullable column, pragma-gated `ALTER` (the `context_usage_json` pattern).
4. The Supervisor (sole writer) writes `todos_json` on a `todos_update` frame for a main session, and sets it to NULL on `todos_clear`. Subagent boards stay in memory.
5. One-time migration backfill: for each non-subagent session, set `todos_json` from its newest non-`read` `manage_todo_list` row in `messages`.
6. `load_session_todos(sessionId)` command reads the column.

## Store (`src/store/sessions.ts`)

7. Constants `INITIAL_PAGE = 500`, `OLDER_PAGE = 200`.
8. Per-session `history: { oldestRowId: number | null; hasMore: boolean; loadingMore: boolean }`.
9. `openSession` loads the tail and seeds `useInteractive.todos[sessionId]` (via `applyTodoUpdate`) from `load_session_todos`.
10. `loadOlderHistory(sessionId)` prepends one page and updates `oldestRowId` / `hasMore`; a no-op while `loadingMore` or when `!hasMore`.
11. `resumeSession` reloads the tail (500), merges with the ADR 0050 identity pass, resets the cursor to the new window, and re-seeds todos. Rows the user had scrolled back to are dropped.

## Rendering (`src/components/chat/MessageList.tsx`, `ChatStream.tsx`)

12. Replace the `overflow-y-auto` div with `<Virtuoso data={units}>`; `MessageList` stays props-only.
    - `computeItemKey` from message identity (`messageId` for text/thought, tool-call `id`, first member's key for a `Changes` group, `at` + ordinal for user messages), prefixed with `activeSessionId` — replaces `${sessionId}:${i}`.
    - The `gap-3` base + `mt-4` tool-pair rhythm becomes per-item top padding with the same pixel values (Virtuoso does not measure margins). `MessageList.gap.test.tsx` is updated.
    - `data-testid="transcript-scroll"` stays on Virtuoso's scroller (`components.Scroller` / `scrollerRef`).
13. `firstItemIndex` decrements by the number of units added on a prepend (new units count − old units count, so a `Changes` group straddling the page boundary is safe). `startReached` → `loadOlderHistory`. A `Header` shows a spinner while `loadingMore`, "Start of conversation" when `!hasMore`.
14. `followOutput` replaces the `scrollTop = scrollHeight` effect: follow new output only while the user is at the bottom (behaviour change — see ADR 0066). A change in the permission / ask / inline-child-gate counts still calls `scrollToIndex("LAST")`.
15. Permission prompts, stacked ask cards, inline child gates, `FileSummaryCard` and the stop-reason line become Virtuoso's `Footer` (not virtualized data). `MessageList` still reads no store.
16. The list remounts on resume (keyed on a generation counter).

## Cleanup

17. `useMainTodoItems` drops its `messages[]` scan fallback and reads only `useInteractive.todos`.

## Tests

- Shared jsdom helper mocking `ResizeObserver` and element sizes; tests pass `initialItemCount`. Expect much of `ChatStream.test.tsx` (~6,900 lines), `App.test.tsx` and `MessageList.gap.test.tsx` to adopt it.
- New: `messages_page` boundaries and `hasMore`; the todos column, backfill and Supervisor write; store paging (prepend, no-op guards, resume reset); `firstItemIndex` arithmetic incl. a `Changes` group across a page boundary; follow-only-at-bottom; stable keys keep expanded state across a prepend.

## Known accepted consequences

- `titleFor`'s first-user-message fallback sees only the window (a windowed session already has a generated title).
- Resume resets the window to the tail.
- A Worker's provider transcript (`native_messages`) is untouched.

## Out of scope

- A bounded sliding window in the store.
- Persisting subagent boards.
