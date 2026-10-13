import { useMemo } from "react";
import { Check } from "lucide-react";
import { Progress } from "./ui/progress";
import { useInteractive, type TodoItem } from "../store/interactive";
import { useSessions } from "../store/sessions";
import { useSubagentSelection } from "../store/subagentSelection";
import { useTodoBoards, type TodoBoard } from "../hooks/useTodoBoards";

/**
 * The main column's todo derivation (extracted so the `SidePane`'s collapsed-rail
 * overview and the panel's checklist consume the SAME derivation and can never
 * disagree):
 *
 * - Interactive todos (the session's `todos_update` board) win.
 * - `rawInput` fallback for non-interactive agents: when the interactive
 *   channel delivered no board for THIS session, the latest
 *   `manage_todo_list` `rawInput` (from the ACP `tool_call` frame, via the
 *   `sessions` store) seeds it. The `title` is the reliable discriminator
 *   (the `name` field is unstable in ACP 1.7).
 *
 * The PARENT's list only — a child never gets this fallback, because it walks
 * the transcript of the session it was called for (`useTodoBoards`' rule 7).
 */
export function useMainTodoItems(sessionId: string | null): TodoItem[] {
  // The selector returns the store's OWN slice — a fresh object (`?? {}`)
  // here would be a new reference on every read and re-render forever.
  const board = useInteractive((state) =>
    sessionId ? state.todos[sessionId] : undefined,
  );
  const messages = useSessions((state) =>
    sessionId ? state.messages[sessionId] : undefined,
  );

  // The latest `manage_todo_list` `rawInput` (written ops only). Derived
  // outside the selector (the selector returns stable references only, or
  // Zustand re-renders forever).
  const rawTodos = useMemo<TodoItem[] | undefined>(() => {
    if (!messages) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (
        message.kind !== "tool-call" ||
        message.title !== "manage_todo_list"
      ) {
        continue;
      }
      const raw = message.rawInput as
        { operation?: string; todoList?: unknown } | undefined;
      if (!raw || raw.operation === "read" || !Array.isArray(raw.todoList)) {
        continue;
      }
      const items = (raw.todoList as Array<Record<string, unknown>>)
        .filter(
          (t) => typeof t.content === "string" && typeof t.status === "string",
        )
        .map((t) => ({
          content: t.content as string,
          status: t.status as TodoItem["status"],
          description:
            typeof t.description === "string" ? t.description : undefined,
        }));
      if (items.length > 0) return items;
    }
    return undefined;
  }, [messages]);

  // Interactive todos win; the `rawInput` seeds the board only when the
  // interactive channel delivered no board for this session (an absent
  // slice — never an empty array, which is why `applyTodoClear` deletes the
  // key instead of writing one; both halves of that consequence, and the
  // render half, are pinned in `TodoBoardPanel.test.tsx`).
  return board ?? rawTodos ?? [];
}

/**
 * Whether the pointer released on a LIVE text selection — the discriminator
 * between an ACTIVATION and the end of a SELECT-DRAG.
 *
 * A drag that ENDS inside a board releases its pointer on whatever text sat
 * under it, and the mouse target is the whole block, so treating that as an
 * activation threw the child's sheet over the text the user had just selected.
 * A live range (`type === "Range"`) is therefore not an activation; a click
 * that leaves no range — none at all, or the caret a mousedown collapsed — is.
 *
 * ONE predicate, read by BOTH handlers — the container's and the header's. The
 * first version guarded only the container on the theory that the header is
 * "an explicit target, not a surface a drag happens to end on"; that held only
 * while the header was inert chrome. It renders `{board.label}` and
 * `{completed}/{total}`, which are selectable, so a drag ending on that line
 * was the same accident on the same surface. Two copies of the rule would have
 * drifted exactly that way.
 */
function endsSelection(): boolean {
  return window.getSelection()?.type === "Range";
}

/**
 * A board's live item: its `in_progress` entry, else its first OPEN one — the
 * first item that is not `completed` (never a completed one). `undefined` ONLY
 * when the list has no open item.
 *
 * The ONE reading of **Current todo** (`CONTEXT.md`) — the parent's reduced row
 * and a child's reduced row are the SAME function, so the two halves of the pane
 * can never pick a different row for the same list shape. The scan takes
 * `in_progress` wherever it sits (a list can be mid-flight at its third item)
 * and remembers the first open item as the fallback, so "else" is a preference,
 * not a prefix rule.
 *
 * The fallback is "not `completed`", NOT "`pending`", because the status it
 * reads is not trustworthy: `useMainTodoItems` casts ANY model-authored string
 * into the union, while the visibility rule (`useBoardOpenCount`, and rule 4 of
 * `todoBoardsOf`) is `status !== "completed"`. Keying the fallback on `pending`
 * made the two rules disagree — a list whose live item read `"in-progress"`
 * counted toward the count that AUTO-OPENS the frame while this returned
 * `undefined`, so the pane opened and drew zero rows at either level. Matching
 * the negation makes them one rule: an item counts toward the count exactly when
 * it can be the row.
 */
function currentTodo(items: TodoItem[]): TodoItem | undefined {
  let firstOpen: TodoItem | undefined;
  for (const item of items) {
    if (item.status === "in_progress") return item;
    if (firstOpen === undefined && item.status !== "completed") {
      firstOpen = item;
    }
  }
  return firstOpen;
}

/**
 * OPEN items across the whole board — the parent's list PLUS every running
 * child's. The ONE open-count the frame's auto-open and the panel's own gate
 * read.
 *
 * Extracted (rather than hand-written at each call site) for the standing rule
 * behind `useSessionStatus`: a summary that disagrees with the thing it
 * summarises is worse than no summary. The `SidePane`'s visibility and the
 * section it hosts are therefore the SAME fact — a pane that opened on a child
 * board whose section then rendered `null` (or the reverse) is unrepresentable.
 *
 * A fully-completed list counts as ZERO at either level: no board, and it keeps
 * nothing open. The child half comes from `useTodoBoards`, which already drops a
 * child with no open item, so `b.open` is ≥ 1 for every board it returns.
 */
export function useBoardOpenCount(sessionId: string | null): number {
  const mainItems = useMainTodoItems(sessionId);
  const boards = useTodoBoards(sessionId);
  const mainOpen = mainItems.filter((t) => t.status !== "completed").length;
  return mainOpen + boards.reduce((n, b) => n + b.open, 0);
}

/**
 * The three-state indicator: done = check circle, in-progress = `◉`, pending =
 * `○` — PLUS the state in words for assistive tech.
 *
 * The mark is decoration (`aria-hidden` on all three), so on its own it says
 * nothing to a screen reader: every row would announce its text and none of its
 * state (the board's `sr-only` "n of m complete" says how far along the list is,
 * not which row is which). Hence the `sr-only` word — `done` / `in progress` /
 * `pending`, the words the glyphs stand for. `sr-only` is absolutely positioned,
 * so the row's flex layout is untouched and every visible glyph is unchanged.
 * The word is derived from the SAME branch that picks the glyph, so a status
 * outside the union (`useMainTodoItems` casts any model-authored string) reads
 * exactly as it looks — the `○` and the word `pending` cannot disagree.
 */
function TodoIndicator({ status }: { status: TodoItem["status"] }) {
  if (status === "completed") {
    return (
      <>
        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-success text-success">
          <Check className="size-3" aria-hidden />
        </span>
        <span className="sr-only">done</span>
      </>
    );
  }
  if (status === "in_progress") {
    return (
      <>
        <span
          aria-hidden
          className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-ui-base text-warning leading-none"
        >
          ◉
        </span>
        <span className="sr-only">in progress</span>
      </>
    );
  }
  return (
    <>
      <span
        aria-hidden
        className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-ui-base text-foreground-subtlest leading-none"
      >
        ○
      </span>
      <span className="sr-only">pending</span>
    </>
  );
}

/**
 * A checklist. `label` is the list's ACCESSIBLE NAME, and it is not optional
 * in effect: a bare `<ol>` is an ANONYMOUS `list` region, and the pane presents
 * up to three of them at once (the parent's list plus two child blocks), so
 * without a name an AT user navigating by region hears three identical "list"s
 * and cannot tell which board the rows belong to. The parent's keeps the
 * section's own word; a child's carries its disambiguated `label`.
 */
function TodoItems({
  items,
  label = "Todos",
}: {
  items: TodoItem[];
  label?: string;
}) {
  return (
    <ol aria-label={label} className="space-y-0.5">
      {items.map((item, i) => (
        <li
          key={i}
          className="flex min-h-8 items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-surface-hover"
        >
          <TodoIndicator status={item.status} />
          <span
            className={
              item.status === "completed"
                ? "min-w-0 flex-1 text-ui-base leading-snug break-words text-foreground-subtle"
                : "min-w-0 flex-1 text-ui-base leading-snug break-words text-foreground"
            }
          >
            {item.content}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * One running child's board, as a labelled block (`CONTEXT.md`: **Todo board**).
 *
 * `full` is the density decision and nothing more — the pane passes `true` for
 * the only board at its level and `false` from the second board onward ("a board
 * yields to the boards beside it"). The store always holds the full list; this
 * is a render choice, which is why the `n/m` header counts `board.items.length`
 * and never the rows on screen.
 *
 * THE POINTER TARGET IS THE BLOCK; THE CONTROL IS THE HEADER LINE. Two
 * different audiences, kept apart on purpose.
 *
 * THE CONTROL — what assistive tech and the keyboard use — is the HEADER. A
 * `role="button"` — exactly like a real `<button>` — is **Children Presentational:
 * True**, and an `aria-label` wins the name computation outright: a control that
 * WRAPPED the rows would leave a screen reader with one label (`reviewer 2/3,
 * button`) and not one word of the child's checklist, while the parent's rows (a
 * plain `<ol>` outside any control) stayed exposed — two checklists for a
 * sighted user, one for an AT user. So the block is a plain `div`, the rows are
 * its SIBLINGS, and the single role/keyboard target is the header
 * (`tabIndex={0}` + the `Enter`/`Space` handler, which a real `<button>` would
 * have given free).
 *
 * THE POINTER TARGET — what a mouse uses — is the WHOLE BLOCK, because that is
 * what the eye lands on and it is by far the bigger target; a user who clicks a
 * row body expects the sheet to open. The container therefore carries `onClick`
 * (+ `cursor-pointer`/`hover`) and deliberately NO `role` and NO `tabIndex`: a
 * bare `div` with a click handler is not exposed as a control, so its children
 * stay in the a11y tree and the shape above survives. That overlap is why the
 * header's own handler calls `stopPropagation` FIRST — otherwise activating the
 * header bubbles into the container and writes the selection twice.
 *
 * The container handler is GUARDED on the selection: a select-drag that ENDS
 * inside the block releases its pointer on a row, and treating that as an
 * activation threw the child's sheet over the text the user had just selected.
 * A live range (`window.getSelection().type === "Range"`) is therefore not an
 * activation; anything else is — no selection at all, or the CARET a mousedown
 * leaves when it collapses one (a double-click's word-select lands here, which
 * is right: that first click is indistinguishable from pointing AT the board).
 * The SAME predicate (`endsSelection`) guards the HEADER too, because the
 * header's own label and
 * count are selectable text, so a drag can end on the control exactly as it
 * ends on a row.
 *
 * That header is a `div[role=button]` rather than a `<button>` because a
 * `<button>`'s content model is phrasing content and so forbids the block-level
 * `<p>` the header is. Its `aria-label` follows the naming convention the roster
 * already uses (`SubagentDelegatingCard`: `Open ${agentName} transcript`) and
 * carries the DISAMBIGUATED `label`, so two same-named children announce
 * differently. The visible `n/m` lives inside that labelled control and is
 * presentational there; the same numbers ride on an `sr-only` sibling OUTSIDE it,
 * because the counts are the progress cue for the board as a whole (each ROW
 * carries its own state word — see `TodoIndicator`).
 */
function ChildBoard({ board, full }: { board: TodoBoard; full: boolean }) {
  const current = currentTodo(board.items);
  // REDUCED means exactly one row; the `undefined` guard is the same
  // load-bearing one the parent's rows carry (a board the derivation kept always
  // has an open item, so it is belt-and-braces — but rendering `undefined` here
  // would throw inside `TodoItems`, and take the whole pane with it).
  const rows = full ? board.items : current === undefined ? [] : [current];
  return (
    <div
      data-testid="todo-board-child"
      data-child={board.childSessionId}
      /* The MOUSE target: the whole block (see the component doc). No `role`, no
         `tabIndex` — it must stay a non-control container so the rows and the
         header inside it remain exposed.

         GUARDED, because "any click inside the block" is wider than "the user
         meant to activate it": finishing a select-drag over a row releases the
         pointer INSIDE the block, and that used to throw the child's sheet on
         top of the text the user had just selected. See `endsSelection` for the
         predicate and why BOTH handlers read it. */
      onClick={() => {
        if (endsSelection()) return;
        useSubagentSelection.getState().select(board.childSessionId);
      }}
      className="min-w-0 cursor-pointer rounded-md border-l border-foreground-subtlest pr-1 pl-2.5 hover:bg-surface-hover"
    >
      {/* The header IS the control: one obvious target, and nothing it names.
          Its handler stops propagation so the container's click (the same
          action) does not also fire, and then reads the SAME guard — the line's
          own label and count are selectable text, so a drag can end on the
          control just as it ends on a row. The TASK is deliberately absent — the
          pane is 240–480px wide and the task text already fills the child's own
          sheet and the "Delegating" card. */}
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open ${board.label} transcript`}
        onClick={(e) => {
          e.stopPropagation();
          if (endsSelection()) return;
          useSubagentSelection.getState().select(board.childSessionId);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            useSubagentSelection.getState().select(board.childSessionId);
          }
        }}
        className="flex w-full items-center gap-1.5 rounded-md text-left focus-visible:outline-1"
      >
        <p className="flex items-center gap-1.5 text-ui-xs text-foreground-subtlest">
          <span className="truncate">{board.label}</span>
          <span>
            {board.completed}/{board.items.length}
          </span>
        </p>
      </div>
      {/* The counts, for assistive tech: inside the control they are swallowed
          by its `aria-label`, so they need this sibling to be readable at all.
          (Each ROW's own state is carried by `TodoIndicator`'s `sr-only` word.) */}
      <span className="sr-only">
        {board.completed} of {board.items.length} complete
      </span>
      <TodoItems items={rows} label={`${board.label} checklist`} />
    </div>
  );
}

/**
 * The Session's todo boards (the `SidePane`'s TODOS SECTION — the ZCode
 * `Goal`/`Progress` treatment: the header carries the label + the count, the
 * body the progress bar + checklist), the parent's first and then ONE BLOCK PER
 * RUNNING CHILD:
 *
 * - **Visible while any board has an open item** (the user's rule, now
 *   board-wide): `mainOpen === 0 && boards.length === 0` renders `null` — no
 *   todos at all, or every list fully completed (the old "No todos yet"
 *   placeholder is gone). That is the SAME zero-set the frame's auto-open reads
 *   from `useBoardOpenCount`, so the pane and the section it hosts can
 *   never disagree, and a delegation whose parent never wrote a list still
 *   opens the frame.
 * - **The parent yields to its children** (`CONTEXT.md`: **Reduced board** / Full
 *   board): with no child board the parent shows its FULL list; once any child
 *   board shows it shows its one **Current todo** (`currentTodo`) — which can be
 *   `undefined`, and then it renders NO row at all. That guard is load-bearing:
 *   a fully-completed parent list beside a live child is exactly that case, and
 *   there is no `Todos` header either (the header's gate is the parent's own
 *   open count).
 * - Header (parent only, only while it has an open item): the `Todos` label +
 *   `N/M` + the `progress` bar (primary fill). Checklist rows carry the
 *   three-state indicators (done = a `size-4` check circle `text-success` +
 *   label `text-foreground-subtle`; in-progress = `◉` `text-warning`; pending =
 *   `○` `text-foreground-subtlest`) — decoration only, so each row also carries
 *   its state as an `sr-only` word (`TodoIndicator`).
 * - **Child boards** come from `useTodoBoards` — keyed to the CHILD's id
 *   (ADR 0041) and joined to this session by `parentSessionId`, so the panel
 *   needs no `source` label (and renders none). A block's HEADER is its
 *   CONTROL — what assistive tech and the keyboard use — and it opens that
 *   child's transcript sheet (`SubagentDetailHost`); the rows sit BESIDE it, so
 *   a screen reader still hears the checklist, while the block's own `div` stays
 *   the MOUSE target for the pointer (see `ChildBoard`). A child's list is FULL
 *   when it is the only board, one row once a second appears.
 * - `rawInput` fallback for non-interactive agents (via `useMainTodoItems`) —
 *   the PARENT's transcript only; a child never gets it.
 * - The `SidePane` frame owns when it APPEARS, and only that: it EXPANDS on the
 *   0 → >0 edge of this same count and NEVER collapses itself (ADR 0042) — the
 *   pane's own toggle is the only thing that closes the frame. So a board
 *   FINISHING leaves the frame open with this section gone, not the frame shut.
 */
export default function TodoBoardPanel({
  sessionId,
}: {
  sessionId: string | null;
}) {
  const mainItems = useMainTodoItems(sessionId);
  // The running children of THIS session that have a board (arrival order,
  // labelled — `useTodoBoards`).
  const boards = useTodoBoards(sessionId);
  // The visibility filter (the SAME open-item rule the frame's auto-open uses):
  // the section renders only while SOME list has an OPEN item — a fully-completed
  // list is hidden, at either level.
  const mainOpen = mainItems.filter((t) => t.status !== "completed").length;

  // No board anywhere (no todos at all, or every list completed) → hidden. Every
  // board `useTodoBoards` returns has ≥ 1 open item, so this is `boardOpen === 0`
  // restated over the two values the render already needs — not a second rule.
  if (mainOpen === 0 && boards.length === 0) {
    return null;
  }

  const completed = mainItems.filter((t) => t.status === "completed").length;
  const current = currentTodo(mainItems);

  return (
    <div className="flex flex-col gap-3">
      {mainOpen > 0 && (
        <div>
          {/* The section header (the ZCode `Goal` row treatment): the
              label + the open count (N/M — the completed count is part
              of the fraction; the OPEN count carries the cue). Gated on
              the PARENT's own open items: with nothing open it has no
              board to head, and a header counting 0 rows would be a
              label for empty space. */}
          <div className="flex items-center gap-2">
            <p className="text-ui-base font-medium">Todos</p>
            <span className="text-ui-xs text-foreground-subtlest">
              {completed}/{mainItems.length}
            </span>
          </div>
          <Progress value={(completed / mainItems.length) * 100} />
        </div>
      )}
      {/* The parent's rows: the FULL list while it is the only board, its one
          Current todo once a child board shares the pane. `current ===
          undefined` → NO row (see the doc). */}
      {boards.length === 0 ? (
        <TodoItems items={mainItems} />
      ) : (
        current !== undefined && <TodoItems items={[current]} />
      )}
      {/* The child blocks, in board (arrival) order. One board → its FULL list;
          two or more → each reduced to its Current todo. */}
      {boards.length > 0 && (
        <div className="flex flex-col gap-2">
          {boards.map((board) => (
            <ChildBoard
              key={board.childSessionId}
              board={board}
              full={boards.length === 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
