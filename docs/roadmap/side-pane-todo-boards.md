---
status: committed
done-when: "With a Subagent session running that has written its own todo list, the Side pane shows the parent's Current todo plus one labelled block per running child (its full list for a single child, its Current todo for 2+); the string `native` appears nowhere in the pane; a child's board opens the pane; a finished run leaves the frame open. `pnpm test` + `pnpm build` green."
---

# Side pane todo boards — Plan

**Goal:** The right-hand **Side pane** shows every **Todo board** the active **Session** owns or supervises — the parent's live item plus one labelled block per running **Subagent session**.

**Architecture:** `useInteractive.todos` becomes `Record<sessionId, TodoItem[]>` — one board per session, attributed by the session id that already rides every frame (ADR 0041), never by the wire `source` label. A new pure derivation (`todoBoardsOf`) joins `useSubagents` on `parentSessionId` to find the children of the active session, exactly like `useChildGates` does for gates. `TodoBoardPanel` renders the boards (a board yields to the boards beside it), `SidePane` opens itself on any open board and never closes itself (ADR 0042), `TodoRail` draws one mark per board.

**Tech Stack:** React 19 + TypeScript, Zustand, Vitest + Testing Library, Tailwind. **No Rust changes in this plan** — nothing in `src-tauri/` is edited (the Rust files named below are read-only evidence).

**Branch:** create `feature/side-pane-todo-boards` off `main` (gitflow-branching skill; no ticket id — this repo's branches carry none) before Task 0; squash-merge on ship.

**Commands** (all from the repo root — no `src-tauri/` validation, there is no Rust change):
- one file: `pnpm test src/store/interactive.test.ts`
- everything: `pnpm test`
- type-check + build: `pnpm build` (`tsc && vite build` — `tsc` is the ONLY static gate; there is no ESLint config, and `tsconfig.json` sets `noUnusedLocals`/`noUnusedParameters`, so an unused destructured prop is a build error)

**Test-env facts (so nobody re-derives them):** no `setupFiles`, no jest-dom → no `toBeInTheDocument`; assert with `screen.getBy*/queryBy*`, `textContent`, `className`. `renderHook` comes from `@testing-library/react`.

---

## Background (read this before Task 0)

The desktop emits a `todos_update` `interactive-event` from `todo_apply`
(`src-tauri/src/agent/interactive/mod.rs:297-310`). Two facts decide everything:

1. **`payload.source` is always the literal `"native"`.** `src-tauri/src/agent/harness/loop.rs:1477`
   passes that string for a Main session and a Subagent session alike. The old store
   branched on it (`source === "main"` → `main`, else → `subagents[source]`), so a MAIN
   session's board was filed under `subagents["native"]` and the panel drew it as a
   subagent block — the `native` heading and the `pl-6` indent users see today.
2. **`payload.sessionId` is already correct.** The Supervisor re-emits a Subagent's
   `SinkFrame`s verbatim (`src-tauri/src/agent/session/router.rs:34-39`), so a child's frames
   carry the CHILD session id (the pump's `delivery_id`
   (`src-tauri/src/agent/worker/manager.rs:645-656`) is the PARENT id, but it routes the
   router — it does not rewrite the payload). The Client therefore always knew which session
   a board belongs to; the panel just never joined the child id to its parent.

`useSubagents.entries` (`src/store/subagents.ts`) is that join: every `SubagentEntry`
carries `sessionId`, `parentSessionId`, `agentName`, `task`, `status` (`running` /
`completed` / `failed`), `startedAt`. Vocabulary is in `CONTEXT.md` (**Todo board**,
**Current todo**, **Reduced board / Full board**, **Side pane**); the two decisions are
ADR 0041 and ADR 0042 in `docs/decisions/`.

Two rules repeated across the tasks, because they are the whole design:

- **Current todo** of a list = its `in_progress` item, else its FIRST `pending` item. Never
  a `completed` item, and `undefined` ONLY when the list has no open item.
- **A board yields to the boards beside it**: the parent's board shows one row whenever any
  child board shows; a child's board shows its full list when it is the only one, and one
  row as soon as a second child board appears.

**Verified non-issues — do not re-check, they were checked against the tree:**
`TodoColumn` has no consumer outside `interactive.ts`; `applyTodoClear` has exactly one
production call site (`src/App.tsx:136`); `useMainOpenTodoCount` has one consumer
(`src/components/SidePane.tsx:174`) plus its own test in
`src/components/TodoBoardPanel.test.tsx`; `TodoRail` has one consumer
(`src/components/SidePane.tsx:359`); `useInteractive.todos` is read only by
`TodoBoardPanel`, and the other `todos: {}` seeds (`SpacesList.test.tsx:124`,
`useAttentionAlert.test.ts:170`, `useHasPendingRequest.test.ts:24`) stay type-valid under
`Record<string, TodoItem[]>`; `useSubagentSelection.getState().select(id)` is what opens
`SubagentDetailHost` (see `SubagentDelegatingCard.tsx:699`); `src-tauri/` emits no
`todos_clear` frame at all.

---

### Task 0: Clear the red baseline (repo hygiene, unrelated to the feature)

**Context:**
`pnpm test` **fails at HEAD**, before any feature work: `src/lib/subagentSheetLayout.test.ts`
keeps a `PROSE` array of docs that must not carry a bracketed dodge class
(`right-[…]` / `max-w-[calc(100vw-…)]`) and `readFileSync`s every entry — one entry,
`docs/roadmap/subagent-gates-in-parent-transcript.md`, was deleted when that feature shipped
(AGENTS.md: roadmap docs are deleted on ship), so the scan dies with `ENOENT` and every
later task's "`pnpm test` → green" gate is unsatisfiable. Fixed here, in its own commit, so
the feature commits stay single-purpose.

**Files:**
- Modify: `src/lib/subagentSheetLayout.test.ts` (the `PROSE` array at `:70-73`)

**What to implement:**
- Delete the `"docs/roadmap/subagent-gates-in-parent-transcript.md"` entry from `PROSE`.
- Extend the `PROSE` doc block with one line: a roadmap doc is DELETED ON SHIP, so removing
  it from `PROSE` is part of the shipping commit — the scan has no tolerance for a missing
  file on purpose, because silently skipping one would let a doc escape the scan.
- Do NOT add `docs/roadmap/side-pane-todo-boards.md` (this plan) to `PROSE`: it never quotes
  the dodge's class.
- Nothing else changes. Keep both remaining entries.

**Steps:**
- [ ] `pnpm test src/lib/subagentSheetLayout.test.ts` — confirm it fails with `ENOENT … subagent-gates-in-parent-transcript.md` (this is the red you are fixing; it must fail BEFORE the change).
- [ ] Remove the stale entry + add the doc line.
- [ ] `pnpm test src/lib/subagentSheetLayout.test.ts` → green.
- [ ] `pnpm test` → 79 files green, 0 failures. If anything else is red, STOP: the baseline is not what this plan says it is.
- [ ] Commit: `test: drop the shipped roadmap doc from the layout prose scan`

**Acceptance criteria:**
- [ ] `pnpm test` is fully green at this commit.
- [ ] `docs/features/subagent-sessions.md` is still in `PROSE` (it is Tailwind-scanned, so Tasks 1/4 must not write a bracketed class like `right-[320px]` into it).

---

### Task 1: Key todo boards by session id (the `native` fix)

**Context:**
`useInteractive` holds `TodoColumn { main, subagents }` and routes a `todos_update` push by
`payload.source`, which is always `"native"` (see Background). Result: a parent's own list
renders under a `native` heading, indented; `column.main` is an empty ARRAY so
`useMainTodoItems`' `?? rawTodos` fallback cannot fire; and `useMainOpenTodoCount` reads 0,
so the Side pane never auto-opens for a session that has an open list. ADR 0041 replaces the
column with one list per session id and stops reading `source` at all. This task also frees a
child's slice when it closes — today NOTHING ever clears a child's todos (no `session-closed`
names a child, and `src-tauri/` emits no `todos_clear` frame at all).

**Files:**
- Modify: `src/store/interactive.ts`
- Modify: `src/components/TodoBoardPanel.tsx` (`useMainTodoItems` + delete the subagent-column render)
- Modify: `src/App.tsx` (the `todos_clear` listener call; the `listenSubagentClosed` handler gains the clear)
- Modify: `src/hooks/useChildGates.ts` (ONE clause of one doc sentence — see below)
- Modify: `docs/features/subagent-sessions.md` (the Follow-ups section at `:296`)
- Test: `src/store/interactive.test.ts`, `src/components/TodoBoardPanel.test.tsx`, `src/App.test.tsx`

**What to implement:**

- `src/store/interactive.ts`:
  - Delete `interface TodoColumn`. The state field becomes
    `todos: Record<string, TodoItem[]>` — "one session's OWN `manage_todo_list` list, keyed
    by that session's id (main OR Subagent); one Session runs one Agent harness, so exactly
    one board (ADR 0041)".
  - `applyTodoUpdate(sessionId, payload)`: keep the shape guard, drop the `source` type
    check → `if (!p || !Array.isArray(p.todos)) return state;` then
    `todos[sessionId] = p.todos`. It MUST NOT read `p.source`. Comment the branch-free write
    with ADR 0041 so nobody "restores" the branch.
  - Change `applyTodoClear(sessionId, payload)` to `applyTodoClear(sessionId: string): void`
    → delete the key from a spread copy, return `state` unchanged when the id is absent.
    Update its interface doc: a clear drops the whole board; the payload's `source` is not
    consulted. KEEP THE NAME (and the `apply*` prefix its siblings `applyState` / `applyCost`
    use): ADR 0041's Consequences sentence about this method stays literally true, and
    `docs/decisions/` is append-only, so a rename would leave a dangling symbol no CI can see.
  - `dismissSession` unchanged (it already deletes the session's whole slice).
  - Keep `TodoUpdatePayload` / `TodoClearPayload` (they document the wire).
  - REWRITE the second half of the long doc block on `InteractiveRequestData.source`
    (`:26-48`). KEEP: `"native"` is the only value today's emitters send, `"main"`/`"sudo"`
    are fixture-only, and `AskQuestionCard`'s `source === "main"` branch is therefore dead.
    REPLACE the part that asserts, in the present tense, that `applyTodoUpdate` "routes
    wrongly" / `column?.main` is `[]` / `useMainOpenTodoCount` reports 0 — all false now —
    with: "Boards are keyed by session id, never by this label (ADR 0041); a future real
    `source` must arrive as a session identity the Client can join, not a prettier string."
  - In `applyTodoClear`'s doc, state the consequence of deleting the key rather than writing
    `[]`: a `todos_clear` frame (inert today — `src-tauri/` emits none) UNMASKS the
    `rawInput` seed for that session, where the old empty-array write suppressed it.
- `src/components/TodoBoardPanel.tsx`:
  - `useMainTodoItems`: `return todos[sessionId] ?? rawTodos ?? []` (the selector returns
    the store's own slice; never a `?? {}` inside a selector — a fresh object per read
    re-renders forever).
  - DELETE the `subagents` selector, the `subagentEntries` derivation and the whole
    `{subagentEntries.map(…)}` block. Task 3 re-introduces child boards correctly; leaving
    this code keeps drawing `native`.
  - The panel's gate becomes `if (mainOpen === 0) return null;`.
  - Update the component doc block: delete the mis-routing paragraph (fixed), replace the
    subagent-column paragraph with "child boards arrive through `useTodoBoards` (Task 3)".
- `src/App.tsx`:
  - `todos_clear` branch → `s.applyTodoClear(payload.sessionId)`.
  - In the `listenSubagentClosed` handler, alongside `discardSessionMessages(p.sessionId)`
    and `markClosed`, add `useInteractive.getState().applyTodoClear(p.sessionId)`, commented:
    NARROW on purpose — NOT `dismissSession`, which would also wipe the child's pending
    gates and change ADR 0040's documented "a closed child keeps its gate card until
    eviction".
- `src/hooks/useChildGates.ts` (`:113`): that sentence says the `subagent-closed` handler
  discards messages "while clearing NOTHING in `useInteractive` / `usePermissions`". Amend
  the clause to "…while clearing only its **todo board** (ADR 0041) — never its gates or
  permission prompts", so the invariant stays true. No code change.
- `docs/features/subagent-sessions.md`: in Follow-ups (`:296`), the `source` bullet (`:298`,
  mis-routing prose at `:312-325`) describes the routing in the present tense and names
  `useMainOpenTodoCount`
  / `applyTodoClear`. Mark the TODO-BOARD half RESOLVED by ADR 0041 (reword to past tense,
  name `applyTodoClear`'s new single-argument form / `useTodoBoards`), KEEP the
  `AskQuestionCard` dead-branch half and the separate mis-keyed-`interactive-request-close`
  follow-up untouched. Do not write a bracketed Tailwind class into this file (it is in the
  `PROSE` scan from Task 0).

**Steps:**
- [ ] In `src/store/interactive.test.ts`, REPLACE THE WHOLE `describe("todos")` BLOCK
      (`:79-132`) — five of its six assertions read the deleted shape
      (`todos[S1]?.main` at `:85` and `:111`, `column?.subagents[...]` at `:96`,
      `column?.main` at `:99`, `todos[S1]?.subagents`/`?.main` at `:122`/`:131`, plus the two
      `applyTodoClear` calls at `:94`→`:116`/`:125` groups), and `tsconfig.json` has NO
      `noUncheckedIndexedAccess`, so a leftover `?.main` is a `tsc` error in a file under
      `include: ["src"]` — this task's commit does not compile otherwise. The replacement
      cases: `applyTodoUpdate(S1, { source: "native", todos })` writes `todos[S1]`;
      `{ source: "main" }`, `{ source: "subagent:x" }` and a payload with NO `source` key all
      write the SAME `todos[S1]` (the label routes nothing — the regression pin);
      re-delivery replaces the list (latest wins); `applyTodoClear(S1)` deletes the key;
      `applyTodoClear("nope")` returns the identical state object.
- [ ] `pnpm test src/store/interactive.test.ts` — must fail (`todos[sid]` is not an array / the old two-argument call is a type error). If it passes, stop and investigate.
- [ ] Implement the store change. Re-run → green.
- [ ] In `src/components/TodoBoardPanel.test.tsx`: DELETE the three subagent-column tests
      (`:100` "hides a subagent todo column…", `:125` "shows the subagent column(s) when the
      main list is fully completed…", `:142` "renders subagent todo columns as indented
      sub-rows") — they pin the shape this task deletes; Task 3 replaces all three. ADD: a
      `source: "native"` update for `"main1"` renders the `Todos` header + `N/M` + the item
      texts, and `expect(container.textContent).not.toContain("native")` (the reported bug);
      plus a case where NO frame arrived and the `rawInput` seed still renders the board.
- [ ] `pnpm test src/components/TodoBoardPanel.test.tsx` — the new pin fails first (the list renders as a `native` sub-block, or not at all), then passes after the panel change.
- [ ] In `src/App.test.tsx`: add `listenSubagentClosed` to the `./lib/tauri` import at `:4`
      (it is mocked at `:90` but never imported, and no existing test captures it). Open a
      NEW `describe("App (the `subagent-closed` listener)")` with the
      `beforeEach(clearStore)/afterEach(clearStore)` pattern the `session-titled` describe
      uses (`:845-860`), and reuse that describe's capture idiom (`:823`:
      `vi.mocked(listen…).mock.calls` → last call's `[0]`): seed a child board AND a pending
      request for `sub1`, `act(() => onClosed({ sessionId: "sub1", status: "completed",
      … }))` (`SubagentClosedPayload` REQUIRES `status` — `src/lib/tauri.ts:360-365`), then
      assert
      `useInteractive.getState().todos["sub1"]` is `undefined` AND `requests["sub1"]` still
      holds its request (the narrowness pin).
- [ ] `pnpm test src/App.test.tsx` → red, then green after the `App.tsx` change.
- [ ] `pnpm test` → green (79 files). `pnpm build` → clean.
- [ ] Commit: `fix: attribute todo boards by session id, not the source label (ADR 0041)`

**Acceptance criteria:**
- [ ] A main session's list renders in the main section (header + `N/M` + progress) when frames carry `source: "native"`; the string `native` is rendered nowhere.
- [ ] `useMainTodoItems` falls back to `rawInput` when no frame arrived for the session.
- [ ] `subagent-closed` removes the child's todos slice and touches nothing else in `useInteractive`.
- [ ] `TodoColumn` is gone and `applyTodoClear` takes ONE argument (no `source`); no doc in
      `src/` or `docs/` still asserts the mis-routing in the present tense.

---

### Task 2: The `useTodoBoards` derivation

**Context:**
The panel needs "the boards the children of THIS session have, in arrival order, with a label
that tells two same-named children apart". `useChildGates`
(`src/hooks/useChildGates.ts`) is the house pattern — an exported PURE core taking the
stores' slices plus a parent id, a thin hook over it, and a frozen empty array so "nothing"
has one identity. This task adds the derivation with no consumers, so it is commitable on its
own.

**Files:**
- Create: `src/hooks/useTodoBoards.ts`
- Test: `src/hooks/useTodoBoards.test.ts`

**What to implement:**

```ts
import { useMemo } from "react";
import { useInteractive, type TodoItem } from "../store/interactive";
import { useSubagents, type SubagentEntry } from "../store/subagents";

/** One running child's todo board, resolved for one parent Session. */
export interface TodoBoard {
  /** The SUBAGENT session id — the key `useSubagentSelection.select` routes on. */
  childSessionId: string;
  /** `SubagentEntry.agentName`, verbatim. */
  agentName: string;
  /** `agentName`, plus `" 2"`, `" 3"`… in arrival order ONLY when a sibling shares the name. */
  label: string;
  items: TodoItem[];
  completed: number;
  /** The OPEN (non-`completed`) count — the visibility rule, and the block's `n/m` numerator. */
  open: number;
  /** `SubagentEntry.startedAt` — the sort key (child arrival). */
  startedAt: number;
}

/** Boards of the RUNNING children of `parentSessionId` whose list has ≥1 open item. */
export function todoBoardsOf(
  entries: Record<string, SubagentEntry>,
  todos: Record<string, TodoItem[]>,
  parentSessionId: string | null,
): TodoBoard[];

/** The hook form. `null` parent → `NO_BOARDS`. */
export function useTodoBoards(parentSessionId: string | null): TodoBoard[];
```

Rules, in this order (document each in the file):
1. `parentSessionId === null` → the module-level frozen `NO_BOARDS: TodoBoard[]`. State the
   asymmetry with `childGatesOf`, whose `null` means "every child": this one never means
   that, and no caller wants it.
2. `entry.parentSessionId === parentSessionId`.
3. `entry.status === "running"` — a child that completed, failed or was cancelled stops
   taking space; the block disappearing IS the cleanup (its outcome reads in the
   `SubagentDelegatingCard` and its sheet).
4. `items = todos[entry.sessionId] ?? []`; skip the entry when `items` has no OPEN item (an
   all-completed child list renders nothing — the rule the parent's list already obeys).
5. Sort by `startedAt` ascending (arrival; `Object.values` insertion order breaks ties).
6. Label: count `agentName`s within the RENDERED set — a unique name stays bare, a repeated
   name gets `"{name}"`, `"{name} 2"`, `"{name} 3"`… in arrival order.
7. A child's board NEVER gets the `rawInput` seed (that fallback walks the PARENT's
   transcript). Say so in the doc block so the parent/child asymmetry is not read as a bug.

The hook selects `useSubagents((s) => s.entries)` and `useInteractive((s) => s.todos)` —
store slices only, never `?? {}` inside a selector — and `useMemo`s on
`[entries, todos, parentSessionId]`.

**Steps:**
- [ ] Write `src/hooks/useTodoBoards.test.ts` driving the PURE core with object fixtures.
      A fixture MUST include every required `SubagentEntry` field the `todoBoardsOf`
      signature takes (`sessionId`, `parentSessionId`, `agentName`, `task`, `status`,
      `startedAt`) or `pnpm build` fails. Cases: parent filter; `completed`/`failed`
      excluded; all-completed list excluded; a running child with an open item INCLUDED with
      `completed`/`open` counted; arrival order by explicit `startedAt` values (e.g. 1000
      before 2000); `label` gains `" 2"` for the second `researcher` and stays bare when the
      names are unique; `parentSessionId: null` → `[]`.
- [ ] Add ONE `renderHook(() => useTodoBoards("main1"))` case that seeds the real stores —
      and reset them first (`for (const id of Object.keys(useSubagents.getState().entries))
      useSubagents.getState().dismiss(id); useInteractive.getState().dismissSession("sub1");`)
      so nothing leaks between cases in this file.
- [ ] `pnpm test src/hooks/useTodoBoards.test.ts` — fails (module missing).
- [ ] Implement `src/hooks/useTodoBoards.ts`. Re-run → green.
- [ ] `pnpm build` → clean. `pnpm test` → green.
- [ ] Commit: `feat: derive the todo boards of a session's running children`

**Acceptance criteria:**
- [ ] `todoBoardsOf` is pure (no store reads inside) and exported alongside the hook.
- [ ] Only `running` children with ≥1 open item appear; order is child arrival (pinned with explicit `startedAt` fixtures).
- [ ] Duplicate `agentName`s are index-disambiguated; unique ones are not.

---

### Task 3: Render the child boards (density + click-through)

**Context:**
With the boards derivable, the pane shows them. The pane is 240–480px and VERTICAL, so the
TUI's side-by-side columns (`packages/todo/src/ui/todo-widget.ts` in the pi-archimedes
monorepo) become stacked blocks: **a board yields to the boards beside it** — the parent
reduces to its **Current todo** while any child board shows; a child shows its full list when
it is the only board and one row once a second appears. The parent's own list must ALSO stop
distinguished by a left border rather than an indent (the `pl-6` indent dies with the
mis-routed block in Task 1): a bar reads as "someone else's list" at any width. The pane's
visibility rule becomes board-wide, so a delegation whose parent never
wrote a list still opens the frame.

**Files:**
- Modify: `src/components/TodoBoardPanel.tsx`
- Modify: `src/components/SidePane.tsx` (the derivation rename + its doc; the rail call and collapse logic stay EXACTLY as they are — Task 5 owns the rail)
- Modify: `src/hooks/useChildGates.ts` (`:86`) and `src/hooks/useSessionStatus.ts` (`:65`) — each cites `useMainOpenTodoCount` BY NAME in a doc comment; re-point them at `useBoardOpenCount`. No code change.
- Modify: `CONTEXT.md` (the **Current todo** entry, `:166`) — it says the Current todo is "never nothing", which is exactly the case (i) below renders as NO row. Reword to: "…never a `completed` item, and `undefined` only when the list has no open item at all — a fully-completed parent board beside a live child board renders no row."
- Test: `src/components/TodoBoardPanel.test.tsx`, `src/components/SidePane.test.tsx`

**What to implement:**

- In `TodoBoardPanel.tsx`, export the shared helper:
  ```ts
  /** A board's live item: its `in_progress` entry, else its first `pending` one (never a
   *  completed one). `undefined` ONLY when the list has no open item. */
  export function currentTodo(items: TodoItem[]): TodoItem | undefined;
  ```
- Rename the shared count, keeping the "one derivation, many consumers" doc (rewritten):
  ```ts
  /** OPEN items across the whole board — the parent's list PLUS every running child's.
   *  The ONE open-count the frame's auto-open and the panel's own gate read. */
  export function useBoardOpenCount(sessionId: string | null): number;
  ```
  Implementation reads `useMainTodoItems` + `useTodoBoards`:
  `mainOpen + boards.reduce((n, b) => n + b.open, 0)`. DELETE `useMainOpenTodoCount`.
- Panel render order: (1) the parent header (`Todos` + `completed/total` + `<Progress>`) —
  markup unchanged, gate unchanged (the parent's own `mainOpen > 0`); (2) the parent's rows;
  (3) the child blocks in board order. Gate: `if (mainOpen === 0 && boards.length === 0) return null;`
  - Parent rows: `boards.length === 0` → `<TodoItems items={mainItems} />`; otherwise
    `{current !== undefined && <TodoItems items={[current]} />}` where
    `current = currentTodo(mainItems)`. The guard is LOAD-BEARING: a fully-completed parent
    list with a live child renders the panel with no parent row at all (and must not throw).
    `TodoItems` already takes `{ items }: { items: TodoItem[] }` — reuse it, do not fork a
    second row markup, so a single row can never look different from a list row.
- Child block per board — a `div[role=button]`, NOT a `<button>` (a `<button>`'s content model
  forbids the `<ol>`/`<li>` the rows use, and it flattens the list out of the a11y tree):
  ```tsx
  <div
    role="button"
    tabIndex={0}
    data-testid="todo-board-child"
    data-child={b.childSessionId}
    aria-label={`${b.label} ${b.completed}/${b.items.length}`}
    onClick={() => useSubagentSelection.getState().select(b.childSessionId)}
    onKeyDown={(e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        useSubagentSelection.getState().select(b.childSessionId);
      }
    }}
    className="min-w-0 cursor-pointer rounded-md border-l border-foreground-subtlest pr-1 pl-2.5 text-left hover:bg-surface-hover focus-visible:outline-1"
  >
    <p className="flex items-center gap-1.5 text-ui-xs text-foreground-subtlest">
      <span className="truncate">{b.label}</span>
      <span>{b.completed}/{b.items.length}</span>
    </p>
    {/* boards.length === 1 → the child's FULL list; 2+ → its Current todo */}
  </div>
  ```
  Rows inside the block reuse `TodoIndicator` and the existing status text colours
  (`text-foreground` open / `text-foreground-subtle` completed). `useSubagentSelection` is
  `src/store/subagentSelection.ts`; `SubagentDetailHost` is what opens. Do NOT render
  `b.task`, and do NOT import `useSubagents` here just to select.
- `src/components/SidePane.tsx`: import `useBoardOpenCount` instead of
  `useMainOpenTodoCount`, `const boardCount = useBoardOpenCount(activeSessionId);`,
  `const visible = boardCount > 0;`. Reword BOTH prose sites that describe it: the component
  doc at `:40-42` ("the subagent todo columns … the `useMainOpenTodoCount` derivation") and
  the INLINE comment at `:171-172` ("the resolved MAIN-COLUMN OPEN todo count … the SAME
derivation the Todos section's visibility uses") → the whole-board count. Leave
  `<TodoRail items={mainTodoItems} />` and the collapse effect untouched (Tasks 5 and 4 own
  them).

**Steps:**
- [ ] First make the existing file compile against the rename: in
      `src/components/TodoBoardPanel.test.tsx`, change the import at `:3` and the
      `renderHook` case (grep the symbol `useMainOpenTodoCount`; it sits at `:167` before
      Task 1 and drifts up once Task 1 deletes the column tests) to `useBoardOpenCount`
      (parent only → same numbers as before), and extend the `beforeEach` at `:17-20` with
      the store resets the child cases need:
      `for (const id of Object.keys(useSubagents.getState().entries)) useSubagents.getState().dismiss(id);`
      and `useSubagentSelection.getState().select(null);`
      (the pattern `SidePane.test.tsx:40-42` uses). Otherwise entries leak between cases and
      the density assertions become order-dependent.
- [ ] Add the child-board cases (seed
      `useSubagents.getState().addSession({ sessionId: "sub1", parentSessionId: "main1", agentName: "reviewer", task: "review the diff", status: "running" })`
      — `addSession` STAMPS `startedAt` itself, so do not pass it here — plus
      `applyTodoUpdate("sub1", { source: "native", todos: [...] })`):
      - (a) a running child with an open list renders `[data-testid="todo-board-child"]` whose text contains `reviewer`, `2/3` and the child's item text;
      - (b) an all-completed child list renders no block;
      - (c) a `status: "completed"` child renders no block;
      - (d) with a child board present the PARENT shows only its `in_progress` item — assert the completed and pending parent item texts are ABSENT;
      - (e) with no `in_progress` parent item the single row is the FIRST `pending` one;
      - (f) two running children → each block shows exactly one item (density); assert membership by text, NOT order (arrival order is pinned in Task 2 — `addSession` gives same-millisecond entries the same `startedAt`);
      - (g) `fireEvent.click(block)` sets `useSubagentSelection.getState().selectedSessionId` to `"sub1"`, and a `keyDown` with `Enter` does too;
      - (h) the string `native` appears nowhere in `container.textContent`;
      - (i) parent list FULLY completed + one running child with an open list → the panel renders, has NO parent row and no `Todos` header, renders the child block, and does not throw (replaces the deleted `:125` scenario).
- [ ] `pnpm test src/components/TodoBoardPanel.test.tsx` → red, implement, green.
- [ ] In `src/components/SidePane.test.tsx`, split `:268` ("does NOT auto-expand the frame when a subagent session starts") into two cases, and fix the case's body comment (`:276-277`, "the pane is todos-only — a subagent no longer opens it") plus the banner at `:203-205`, which say the same thing:
      - "a subagent session with NO todo board does not open the pane" — keep it seeding nothing (its `entry.parentSessionId` is `"main1"` while the file's `beforeEach` leaves `activeSessionId: null`; that is exactly what it pins);
      - "a running child's open todo board opens the pane" — model it on `:207`, NOT on a seed-before-render: `useSessions.setState({ activeSessionId: "main1" })` (without an active session `useTodoBoards(null)` returns `NO_BOARDS` and the case can never pass), then `act(() => setSidePaneCollapsed(true))` (the `beforeEach` at `:38` leaves the pane OPEN, so nothing else puts it at `SIDE_PANE_RAIL`), then `render(<SidePane />)`, assert `SIDE_PANE_RAIL`, then seed the entry AND `applyTodoUpdate("sub1", { source: "native", todos: [open] })` INSIDE one `act(() => …)` AFTER the mount — seeding before the mount initialises `prevVisibleRef` to `true`, kills the 0 → 1 edge, and the frame never expands — then assert `frame.style.width === "320px"`.
- [ ] `pnpm test src/components/SidePane.test.tsx` → red on the new case, then green.
- [ ] `pnpm test` → green. `pnpm build` → clean (this is where the `noUnusedLocals` gate catches a stranded import).
- [ ] Commit: `feat: show each running subagent's todo board in the side pane`

**Acceptance criteria:**
- [ ] One child → its full list; two children → one row each; the parent → one row whenever any child board shows, its full list when none.
- [ ] A fully-completed parent list with a live child renders no parent row and throws nothing.
- [ ] Each block header is `label` + `completed/total`; the block opens that child's transcript sheet on click AND Enter.
- [ ] `useBoardOpenCount` is the only open-count the frame and the panel gate read, and `useMainOpenTodoCount` has no live (present-tense) reference left in `src/` — `docs/decisions/0041` and the `docs/features/subagent-sessions.md` Follow-up entry keep it as past-tense history, on purpose.

---

### Task 4: The frame opens itself and never closes itself

**Context:**
`SidePane`'s edge effect writes `setSidePaneCollapsed(!visible)` on ANY change, so a board
completing (`visible` 1 → 0) collapses the frame out from under the user mid-run — the
reported "it closed the pane when it was open". With child boards counted, that dip is
routine (one child finishing while siblings work). ADR 0042 removes the collapse arm: the
frame may open itself, never close itself.

**Files:**
- Modify: `src/components/SidePane.tsx`
- Test: `src/components/SidePane.test.tsx`
- Modify: `docs/features/subagent-sessions.md` (the `:168` sentence)

**What to implement:**
- The effect keeps the `prevVisibleRef` update and becomes:
  ```ts
  // Edge-triggered OPEN only (ADR 0042). Nothing here may collapse the pane:
  // `visible` going 1 → 0 is a board FINISHING, which is not a reason to hide the surface
  // that just showed it — the user's toggle is the only thing that closes the frame. The
  // ref survives for the MOUNT edge: with todos already open and the pane collapsed
  // (localStorage said collapsed), `was === visible === true` must NOT re-expand — that is
  // the `does NOT auto-expand on mount when todos already exist` case.
  if (!was && visible) setSidePaneCollapsed(false);
  ```
- Rewrite the component's "Auto open/close (the popup rule)" doc paragraph: the frame
  EXPANDS when open todos go 0 → >0 (the parent's own list or a running child's) and NEVER
  collapses itself; a finished run leaves the frame open with the Todos section gone
  (data-gated) and the session title still there. Cite ADR 0042. Rewrite the INLINE comment
  above the effect too (`:243-248`: "driven by TODOS ONLY (a subagent session never opens
  it…)"), which states the old symmetric rule in the present tense — and the component doc's
  matching sentence at `:46`.
- `docs/features/subagent-sessions.md:168` currently reads "SidePane is todos-only: its auto
  open/close is driven by todos only, a subagent no longer opens the pane" — wrong on the
  second half now: a Subagent's BOARD opens the pane (its session STARTING still does not —
  that is pinned in Task 3). Amend the sentence, and say the frame never auto-collapses. No
  bracketed Tailwind class in this file (it is in the `PROSE` scan).

**Steps:**
- [ ] In `src/components/SidePane.test.tsx`, invert `:240` to "does NOT auto-collapse when all todos complete (ADR 0042)": expand through a 0 → 1 edge, then mark every item `completed` and assert `frame.style.width` is STILL `320px` and `getSidePaneCollapsed()` is STILL `false`.
- [ ] `pnpm test src/components/SidePane.test.tsx` → the inverted test fails. Implement, re-run → green.
- [ ] Confirm UNCHANGED and green: `does NOT auto-expand on mount when todos already exist` (`:225`, the reason `prevVisibleRef` survives) and `respects a MANUAL collapse while work is in flight` (`:283`).
- [ ] `pnpm test` → green. `pnpm build` → clean.
- [ ] Commit: `fix: the side pane opens itself and never closes itself (ADR 0042)`

**Acceptance criteria:**
- [ ] The only call site that collapses the pane is the user's own toggle (`setSidePaneCollapsed(!collapsed)`); no effect or listener ever passes `true`.
- [ ] A run that finishes leaves the frame open; the Todos section is gone, the title stays.
- [ ] A manual collapse during in-flight work is not undone by later todo updates.

---

### Task 5: One rail mark per board

**Context:**
Collapsed, the pane is a 40px sliver and `TodoRail` draws one mark per MAIN item, ignoring
children (its doc says so). One mark per item cannot survive the new shape — a 20-item parent
list fills the sliver and a child's dozen rows are indistinguishable from the parent's. One
mark per BOARD answers what a glance actually asks: how many boards, and which one is live.
All of the rail's prop and test churn lives in THIS task, so no earlier task has to carry a
half-renamed component.

**Files:**
- Modify: `src/components/TodoRail.tsx`
- Modify: `src/components/SidePane.tsx` (pass both inputs)
- Test: `src/components/TodoRail.test.tsx`, `src/components/SidePane.test.tsx` (the rail cases at `:399`, `:421`, `:453`)

**What to implement:**
- `src/components/TodoRail.tsx` — no return-type annotation (React 19's `@types/react` has no
  global `JSX` namespace; `JSX.Element` does not compile here, and the current component infers
  its type fine):
  ```ts
  /** A board's state, decided by its items: any `in_progress` → `active`; every item
   *  `completed` → `done`; otherwise `waiting`. */
  export type BoardState = "active" | "done" | "waiting";
  export function boardStateOf(items: TodoItem[]): BoardState;

  export default function TodoRail({
    mainItems,
    boards,
  }: {
    mainItems: TodoItem[];
    boards: TodoBoard[];
  }) { … }
  ```
  - WIDEN `TodoMark` to `{ status: BoardState }` and switch its three branches to
    `done` (success ring + `Check`), `active` (`bg-warning` fill), `waiting` (hollow) —
    keep every class exactly as it is today, so the existing shape/colour assertions stay
    meaningful. (Do NOT map `BoardState` → `TodoItem["status"]`: a board has no single item
    status to borrow.)
  - Marks: the parent's board FIRST (only when `mainItems.length > 0`), then one per child in
    board order. Keep `MARK_PX`/`CHECK_PX`, `flex-1 min-h-5 max-h-10`, `justify-start`,
    `overflow-hidden`, `inset-x-0 top-2 bottom-9`, `pointer-events-none`, `data-todo-row` on
    each row, `data-testid="todo-mark"` on each mark.
  - Return `null` when `mainItems.length === 0 && boards.length === 0`.
  - `role="img"` + `aria-label` naming every board:
    `Todos — this session 2/5, reviewer 2/5, researcher 1/3`, omitting the `this session`
    term when `mainItems` is empty. Keep the comment that this is the ONLY text in the tree
    while collapsed (the real board is `invisible`).
  - Rewrite the doc block: the "SCOPE: the MAIN list only" paragraph becomes one mark per
    board (parent + running children). Say plainly that the `done` arm is the PARENT's state
    alone: the rail reads the FULL parent list, so a finished parent run still reads as
    ticks, while a CHILD board disappears when its run ends (Task 2 rules 3-4 + Task 1's
    `applyTodoClear`), so an all-completed child never reaches the rail. And the per-item strip
    is gone because a glance at a sliver asks "how many boards, which is live" — not "which
    item". Keep the geometry paragraph (it still explains `justify-start` + the clip
direction with fewer, taller rows).
- `src/components/SidePane.tsx`: pass `mainItems={mainTodoItems}` and
  `boards={useTodoBoards(activeSessionId)}` (compute the boards ONCE in a local and pass
  them; the pane already calls the hook for nothing else). The rail still renders only while
  `collapsed`.

**Steps:**
- [ ] Rewrite `src/components/TodoRail.test.tsx` so it builds BOARDS, not items — the per-item assertions cannot survive one-mark-per-board and must be RE-EXPRESSED, not "kept". All SEVEN render sites pass `items=` today (`:17`, `:27`, `:41`, `:49`, `:78`, `:83`, `:93`, `:101`) and every one must be re-seeded or it is a `tsc` error and a `TypeError` on `undefined.length`:
      - `renders one mark per BOARD, in order, and NO text at all`: `mainItems` of 3 items + 2 boards → exactly 3 marks, and the FIRST mark is the parent's (give the parent an `in_progress` item and the children others, then assert the first mark is `bg-warning`);
      - `draws the three states apart` → one board `done` (`border-success` + an `svg`), one `active` (`bg-warning`, no `border-success`), one `waiting` (`border-foreground-subtlest`, no `bg-`): assert the shapes `["check","filled","hollow"]` from the THREE MARKS;
      - `distributes its rows over the height … and CLIPS instead of scrolling`: keep the intent, drive it with 3 boards instead of 3 items (`[data-todo-row]` length 3, `overflow-hidden`, no `overflow-*-(auto|scroll)`);
      - the `stays out of the way: no pointer capture` case (`:77`) and the `tells the states apart by SHAPE as well as colour` case (`:40`): keep their assertions verbatim, re-seeded with boards;
      - the summary case (`announces itself as a todo summary`) is REPLACED:
        `getByRole("img", { name: "Todos — this session 1/3, reviewer 2/3, researcher 1/3" })`;
      - ADD: `mainItems: []` + one board → one mark, and the name omits `this session`; `mainItems: []` + `boards: []` → renders `null`.
- [ ] `pnpm test src/components/TodoRail.test.tsx` → red (old signature takes `items`). Implement, re-run → green.
- [ ] Fix the three rail cases in `src/components/SidePane.test.tsx` (`:399` paints the overview while collapsed, `:421` hides the board's text in the sliver, `:453` no overview with no todos) for the new props — seed a child entry + its board for the first two. The no-text assertion MUST stay scoped to
`screen.getByTestId("todo-rail").textContent === ""` (as `:443` does): Task 3's child-block
text is still MOUNTED inside the `invisible` board, so a `container.textContent === ""` assertion would fail for a reason that has nothing to do with the rail. `:453` keeps its "no todos at all → no `[data-testid="todo-rail"]`" assertion.
- [ ] `pnpm test src/components/SidePane.test.tsx` → green.
- [ ] `pnpm test` → green. `pnpm build` → clean.
- [ ] Commit: `feat: one rail mark per todo board (parent + running children)`

**Acceptance criteria:**
- [ ] Collapsed, the sliver shows the parent mark (when the parent has a list) + one per running child, and no text node.
- [ ] `aria-label` names every board with its own `n/m`.
- [ ] The rail's geometry guards (no scrollbar, `bottom-9` clearance, `flex-1` rows with the 20px/40px bounds) still hold.

---

## Final verification

1. `pnpm test` and `pnpm build` from the repo root — both green (no `cargo` runs: `src-tauri/` is untouched).
2. Manual, with two subagents that each write their own list: the pane opens itself, shows the
   parent's single live row and two labelled blocks (`reviewer 2/5`, `researcher 1/3`), with
   the word `native` nowhere; collapse the pane and count three marks; let everything finish
   and confirm the frame STAYS open with the sections gone.
3. Refresh the verification stamp the docs carry: `docs/features/subagent-sessions.md`
   front-matter (`last-verified` / `verified-by`, `:3-4`) gets this branch name and the final
   `pnpm test` / `pnpm build` counts — every stamped feature doc in `docs/features/` follows
   that convention.
4. On ship: fold the durable behaviour into `docs/features/` (or leave ADR 0041/0042 as the
   durable record), delete this roadmap doc, and — because Task 0 documented the rule — do NOT
   leave this file path in any scan list.
