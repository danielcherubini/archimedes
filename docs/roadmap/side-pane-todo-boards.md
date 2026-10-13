---
status: approved
done-when: "With a Subagent session running that has written its own todo list, the Side pane shows the parent's Current todo plus one labelled block per running child (its own list, or its Current todo when 2+ children work); the string `native` appears nowhere in the pane; a child's board opens the pane; and the pane never collapses itself. `pnpm test` and `pnpm build` green."
---

# Subagent todo boards in the Side pane

## Problem

Two symptoms, one cause.

1. **The parent's own list is labelled `native` and indented.** Every `todos_update` the
   desktop emits carries `source: "native"` — `src-tauri/src/agent/harness/loop.rs:1475`
   hands that literal to `todo_apply` for a **Main session** and a **Subagent session**
   alike. `useInteractive.applyTodoUpdate` (`src/store/interactive.ts:162`) branches
   `source === "main"` → `main`, **else** → `subagents[source]`, so a main session's board
   is filed under `subagents["native"]` and `TodoBoardPanel` renders it as a subagent
   block: the `native` header, the `pl-6` indent.
   Written up as a follow-up in `docs/features/subagent-sessions.md:299-330`.
2. **A child's todos are stored and drawn nowhere.** A **Subagent session**'s
   `interactive-event` frames are re-emitted VERBATIM by
   `src-tauri/src/agent/session/router.rs:36`, so the payload keeps the CHILD session id,
   while `SidePane` passes `activeSessionId` to `TodoBoardPanel`. Nothing joins the two.

Two hidden consequences of (1): because `column.main` is then an empty ARRAY rather than
`undefined`, `useMainTodoItems`' `?? rawTodos` fallback cannot fire, so `rawInput` never
seeds a board; and `useMainOpenTodoCount` therefore reads 0, so **the pane never
auto-opens** for a session that has an open list.

And a third thing the user reported: the frame sometimes CLOSES itself while open. That is
`SidePane.tsx:222-228` writing `setSidePaneCollapsed(!visible)` on any edge — a board
completing collapses the pane.

## Reference

`~/Coding/Javascript/pi-archimedes/packages/todo/src/ui/todo-widget.ts` renders main +
child boards as **side-by-side columns** in the TUI (`subagent (general)` header, per-child
list, `│` dividers) — see `docs/images/todos-and-subagent.png` and
`todos-multiple-todos.png`. The pane is 240–480px and VERTICAL, so the columns become
stacked blocks: the parent yields its rows, the children get blocks.

## Decisions already taken

- ADR 0041 — boards are attributed by **session id**, never by the wire `source` label.
  The Rust emitter is deliberately NOT changed (the option is recorded there with its
  rejection reason).
- ADR 0042 — the **Side pane** opens itself and never closes itself.
- `CONTEXT.md` gained **Side pane**, **Todo board**, **Current todo**, **Reduced board /
  Full board**.

## Design

### 1. Store — one board per session (`src/store/interactive.ts`)

```ts
/** One session's OWN `manage_todo_list` list, keyed by that session's id — main OR
 *  Subagent. One Session runs one Agent harness, so exactly one board (ADR 0041). */
todos: Record<string, TodoItem[]>;
```

- Delete `TodoColumn` and the `subagents` map.
- `applyTodoUpdate(sessionId, payload)`: validate `Array.isArray(payload.todos)`, write
  `todos[sessionId]`. **Does not read `payload.source`** — the doc block on
  `InteractiveRequestData.source` stays (it explains the transport label) and gains a line
  saying boards are keyed by session id (ADR 0041).
- `clearTodos(sessionId)` replaces `applyTodoClear` (payload no longer consulted — a clear
  drops the whole board). Two callers: the `todos_clear` listener and `subagent-closed`.
- `dismissSession` unchanged.

### 2. Derivation — `src/hooks/useTodoBoards.ts` (new)

Shaped like `childGatesOf` (`src/hooks/useChildGates.ts`): an exported PURE core plus a
thin hook, and a frozen `NO_BOARDS` array so "nothing" has one identity.

```ts
interface TodoBoard {
  childSessionId: string; // routes the click to the child's sheet
  agentName: string;      // SubagentEntry.agentName
  label: string;          // agentName, + " N" ONLY when a sibling shares it
  items: TodoItem[];
  completed: number;
  open: number;           // non-completed count — the visibility rule
  startedAt: number;      // arrival order (the same sort key childGatesOf uses)
}

function todoBoardsOf(
  entries: Record<string, SubagentEntry>,
  todos: Record<string, TodoItem[]>,
  parentSessionId: string | null,
): TodoBoard[];
function useTodoBoards(parentSessionId: string | null): TodoBoard[];
```

Rules, in order: `entry.parentSessionId === parentSessionId` → `entry.status ===
"running"` → `todos[entry.sessionId]` has ≥1 OPEN item (an all-completed child list
renders nothing, as a completed column does today). Sort by `startedAt`. The duplicate-name
index is assigned in arrival order over the RENDERED set only — `researcher`, `researcher 2`
when two running children share a name, bare `researcher` when one.
`parentSessionId === null` → `NO_BOARDS` (unlike `childGatesOf`'s `null` = "every child";
state the asymmetry in the doc block, as that file does).

### 3. Render — `src/components/TodoBoardPanel.tsx`

```
NO CHILD BOARDS                A CHILD BOARD EXISTS
──────────────                 ───────────────────────────
Todos  2/5  ▓▓░░░              Todos  2/5  ▓▓░░░
◉ Fix the router               ◉ Fix the router          ← Current todo only
○ Write the tests              │ reviewer · 2/5           ← border-l, not pl-6
○ Wire the sidebar             │ ✓ Fix the card
○ Write the docs               │ ◉ Cover the rail
                               │ researcher · 1/3          ← 2nd board: current only
                               │ ◉ Trace the pump
```

- Header (`Todos` + `completed/total` + `<Progress>`) unchanged: main-only fraction, still
  gated on "the main list has ≥1 open item".
- **Current todo** of a list = its `in_progress` item, else its FIRST `pending` item. Never
  a `completed` one, never empty (a reduced row always has one — the caller renders the row
  only when the list has an open item, which is already the gate).
- Main list: FULL when `boards.length === 0`, one **Current todo** row otherwise.
- Child block, in arrival order: `border-l border-foreground-subtlest` + a small left pad
  (replaces `pl-6` — a bar says "someone else's list", a bare indent just drifts right);
  header line `label` + ` n/m` in `text-ui-xs text-foreground-subtlest`; body reuses
  `TodoIndicator` and the existing per-status text colours; FULL list when it is the only
  child board, **Current todo** when there are 2+.
- A block is a `<button>` calling `useSubagents.getState().select(childSessionId)` — the
  same action as its row under the Delegating card, opening `SubagentDetailHost`.
- Density rule in one line, in the component's doc block: **a board yields to the boards
  beside it** (the parent yields to any child, a child yields to any sibling).
- `useMainOpenTodoCount` → `useBoardOpenCount(sessionId)`: the parent's open items PLUS the
  open items of every board from `useTodoBoards`. The panel and the frame keep reading the
  ONE derivation.

### 4. Frame — `src/components/SidePane.tsx`

- `visible = useBoardOpenCount(activeSessionId) > 0`, so a delegation whose parent never
  wrote a list still opens the pane.
- The edge effect keeps only its open arm (ADR 0042):

```ts
if (!was && visible) setSidePaneCollapsed(false);
```

  Nothing may call `setSidePaneCollapsed(true)`. A finished run leaves the frame open and
  empty (the section is data-gated; the session title remains) — accepted.
- Rewrite the "Auto open/close (the popup rule)" doc paragraph and the SCOPE sentence in
  the component header (the pane is no longer the parent's board alone).

### 5. Rail — `src/components/TodoRail.tsx`

- Props: `boards: Array<{ key: string; state: "done" | "active" | "waiting"; label: string;
  completed: number; total: number }>` — the parent's board first, then children in arrival
  order. Board state: has an `in_progress` item → `active`; all completed → `done`; else
  `waiting`. A board with an all-completed list still gets a mark (a finished run still
  reads as ticks).
- One mark per board instead of one per item; `MARK_PX`/`CHECK_PX` and the
  `flex-1 min-h-5 max-h-10` + `justify-start` geometry unchanged.
- `aria-label` becomes the whole board summary (`Todos — main 2/5, reviewer 2/5, researcher
  1/3`): while collapsed the marks carry no text and the real board is `invisible`, so the
  count lives in the tree exactly once, here.
- Rewrite the "SCOPE: the MAIN list only" paragraph.

### 6. Cleanup — `src/App.tsx`

The `listenSubagentClosed` handler calls `useInteractive.getState().clearTodos(p.sessionId)`
alongside the existing `discardSessionMessages` + `markClosed`. NARROW on purpose: NOT
`dismissSession`, which would also wipe the child's pending gates and silently change ADR
0040's documented "a closed child keeps its gate card until eviction". The gate-slice leak
stays the follow-up it already is.

## Tests

TDD, one file at a time, red first.

1. `src/store/interactive.test.ts` — `applyTodoUpdate(sid, { source: "native", todos })`
   writes `todos[sid]` (the bug-#1 pin; the current `subagents["subagent:x"]` assertion at
   `:96` becomes a session-keyed one), same for `source: "main"`, so the label no longer
   routes; `clearTodos` deletes the slice; a `source`-less payload still applies.
2. `src/hooks/useTodoBoards.test.ts` (new, drives the pure core) — parent filter;
   `running` only; open-item rule; arrival order; `label` gains an index ONLY on a
   duplicate; `null` parent → `NO_BOARDS`.
3. `src/components/TodoBoardPanel.test.tsx` — FULL main with no child boards; main reduced
   to the `in_progress` item, and to the first `pending` when none is in progress, once a
   child board exists; child block label + `n/m`; 2 children → each shows one row; a child
   block click calls `useSubagents.select(childId)`; and the string `native` is never in the
   rendered output (the regression pin).
4. `src/components/SidePane.test.tsx` — a CHILD-only board opens the frame (split the
   `:268` "subagent does not open the pane" test in two: no board → stays closed, open
   board → opens); invert `:240` to "does NOT auto-collapse when all todos complete
   (ADR 0042)"; keep the manual-collapse-with-work-in-flight pin.
5. `src/components/TodoRail.test.tsx` — one mark per board, board state → mark shape, the
   `aria-label` names every board.
6. `src/App.test.tsx` — `subagent-closed` clears the child's todos AND NOT its pending
   requests (pins the narrowness).

## Out of scope

- No Rust change of any kind (ADR 0041), `AskQuestionCard`'s dead `source === "main"`
  branch, the mis-keyed child `interactive-request-close` frames, and the child gate-slice
  leak: all still the follow-ups in `docs/features/subagent-sessions.md`.
- No `rawInput` fallback for a child's board (its frames come from the same `todo_apply`,
  so there is nothing to fall back from).
- No change to `SubagentDelegatingCard`, no board persistence, no rename of the wire
  `source` field.

## Exit check

`pnpm test` and `pnpm build` from the repo root. Manual: start a session, write a todo
list, delegate to two subagents that write their own lists — the pane shows the parent's
single live row, two labelled child blocks, and opens itself; let everything finish and
confirm the frame stays open.
