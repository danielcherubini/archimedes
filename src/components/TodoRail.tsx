import { Check } from "lucide-react";
import type { TodoBoard } from "../hooks/useTodoBoards";
import type { TodoItem } from "../store/interactive";

/**
 * Every todo BOARD reduced to one tick or dot, for the collapsed side-pane RAIL
 * (the 40px sliver): the shape of the session's boards at a glance — HOW MANY
 * boards there are, and WHICH ONE is live — with no text and no scrolling.
 *
 * WHY IT EXISTS: the pane's collapse is `SIDE_PANE_RAIL` + `overflow: hidden` —
 * a CLIP, not an unmount, so the board's scroll position (DOM state an
 * unmount would lose) survives it — and the board therefore used to paint
 * INTO the sliver: text wrapped to one character per line
 * ("th / so / is / s …") inside its own `overflow-y-auto`, which then grew a
 * SCROLLBAR in a 40px column. This is the only thing a 40px column can
 * actually render.
 *
 * ONE MARK PER BOARD, the parent's list FIRST and then one per running child
 * THAT HAS A BOARD, in board order — the rail iterates `boards`, not the
 * subagent entries, so a child whose list has no open item is not on it (rule 4
 * of `todoBoardsOf`). It used to be one mark per MAIN ITEM, and that shape does
 * not survive boards: a 20-item parent list fills the sliver with twenty dots
 * the eye cannot group, and a child's dozen rows sit beside them
 * indistinguishable. What a glance at a sliver actually asks is "how many
 * boards, and which one is live" — never "which item", which is what the OPEN
 * pane is for (and the per-item strip was a second, worse copy of it).
 *
 * THE `done` ARM IS THE PARENT'S STATE ALONE, and that is a fact about the
 * inputs, not a gap here: the rail reads the FULL parent list, so a finished
 * parent run still reads as ticks (the frame no longer collapses itself — ADR
 * 0042 — so the user is the one who closes it, usually after the run, and the
 * sliver then says "that one ended"). A CHILD board, though, disappears when
 * its run ends: `todoBoardsOf` keeps only `running` children whose list has an
 * open item, and `subagent-closed` clears the child's slice, so an
 * all-completed child never reaches the rail at all. The arm stays — it maps a
 * state the rail can be handed, and deleting it would make the rail's own
 * vocabulary depend on which caller it happens to have.
 *
 * THE GEOMETRY IS CSS, NOT MEASURED. Each row is `flex-1 min-h-5 max-h-10` in
 * a top-anchored column: the rows share the rail's height, stop shrinking at
 * the 20px floor, and stop GROWING at 40px — so a 2-board session is a tight
 * cluster at the top (it reads as a group) and a session with more boards than
 * fit fills the rail and clips its tail. Fewer, taller marks than the old
 * per-item strip, and the same reason for every number.
 *
 * CLIPPING IS DIRECTIONAL ON PURPOSE, and that pins `justify-start`: an
 * overflowing flex column CENTERS its overflow when justified to the middle,
 * which would cut the FIRST board off the top of the rail — and the parent's
 * mark is the first one, the mark that says "this is the session you are
 * looking at". So the tail is what gets cut, which reads as "more boards than
 * fit" (true, and stable), where a scrollbar would read as "scroll inside the
 * sliver", the behavior this replaces. Because the floor fixes the mark size,
 * the check is always legible and there is no conditional glyph to reason
 * about. The obvious alternative — a `ResizeObserver` computing a pitch — needs
 * a measurement round-trip before anything paints, and would keep shrinking
 * marks past legibility to force a long list to fit.
 *
 * THREE STATES, THREE SHAPES: done = the success ring + a check, active = the
 * warning FILL (the board's `◉`), waiting = the hollow dot. Shape carries the
 * state as well as colour, because a rail is read in a glance and a glance is
 * not a contrast test.
 */

/**
 * A board's state, decided by its items: any `in_progress` → `active`; every
 * item `completed` → `done`; otherwise `waiting`.
 */
export type BoardState = "active" | "done" | "waiting";

/**
 * That rule, applied. Live outranks finished on purpose: a board at 9/10 done
 * with one item running is a board that is RUNNING, which is the question the
 * rail's one hot dot answers. Exported because the rule is the rail's whole
 * vocabulary and a caller must not invent a second one.
 */
export function boardStateOf(items: TodoItem[]): BoardState {
  let allDone = true;
  for (const item of items) {
    if (item.status === "in_progress") return "active";
    if (item.status !== "completed") allDone = false;
  }
  return allDone ? "done" : "waiting";
}

/** A mark's box, and the check inside it. */
const MARK_PX = 12;
const CHECK_PX = 8;

function TodoMark({ status }: { status: BoardState }) {
  const box = { width: MARK_PX, height: MARK_PX };
  if (status === "done") {
    return (
      <span
        data-testid="todo-mark"
        style={box}
        className="flex shrink-0 items-center justify-center rounded-full border border-success text-success"
      >
        <Check style={{ width: CHECK_PX, height: CHECK_PX }} aria-hidden />
      </span>
    );
  }
  if (status === "active") {
    return (
      <span
        data-testid="todo-mark"
        style={box}
        className="shrink-0 rounded-full bg-warning"
        aria-hidden
      />
    );
  }
  return (
    <span
      data-testid="todo-mark"
      style={box}
      className="shrink-0 rounded-full border border-foreground-subtlest"
      aria-hidden
    />
  );
}

export default function TodoRail({
  mainItems,
  boards,
}: {
  mainItems: TodoItem[];
  boards: TodoBoard[];
}) {
  // One entry per mark, in mark order: the parent's board first (only when it
  // HAS a list — a parent that never wrote one gets no mark, and no term in the
  // accessible name either), then one per running child THAT HAS A BOARD (rule
  // 4 of `todoBoardsOf` drops a child whose list has no open item), in board
  // order — which is why the loop below walks `boards`, not the subagent
  // entries.
  const states: BoardState[] = [];
  if (mainItems.length > 0) states.push(boardStateOf(mainItems));
  for (const board of boards) states.push(boardStateOf(board.items));
  if (states.length === 0) return null;

  // One `n/m` term per board — the same fraction the open pane shows for that
  // board (`completed/total`, the child's carried by `TodoBoard` so the rail
  // does not re-count it). A single app-wide count would say nothing about
  // WHICH board is the one to look at.
  const terms: string[] = [];
  if (mainItems.length > 0) {
    const completed = mainItems.filter((t) => t.status === "completed").length;
    terms.push(`this session ${completed}/${mainItems.length}`);
  }
  for (const board of boards) {
    terms.push(`${board.label} ${board.completed}/${board.items.length}`);
  }
  // The accessible name is the board list, because the marks carry no text and
  // the real board behind them is `invisible` while collapsed — so this string
  // is the ONLY text in the tree while collapsed, and the count is in the tree
  // exactly once, here.
  // `top-2` / `bottom-9`: the marks span the rail but stop CLEAR of the frame's
  // bottom-left corner, where the pane's own toggle lives (`bottom-2` +
  // `size-6` = 32px of box, so 36px clears it with room to aim).
  // `pointer-events-none`: a readout must not steal the toggle's click.
  return (
    <div
      data-testid="todo-rail"
      role="img"
      aria-label={`Todos — ${terms.join(", ")}`}
      className="pointer-events-none absolute inset-x-0 top-2 bottom-9 flex flex-col justify-start gap-1 overflow-hidden"
    >
      {states.map((state, i) => (
        <div
          key={i}
          data-todo-row
          className="flex max-h-10 min-h-5 w-full flex-1 items-center justify-center"
        >
          <TodoMark status={state} />
        </div>
      ))}
    </div>
  );
}
