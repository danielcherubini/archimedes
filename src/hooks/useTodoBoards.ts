import { useMemo } from "react";
import { useInteractive, type TodoItem } from "../store/interactive";
import { useSubagents, type SubagentEntry } from "../store/subagents";

/**
 * One running child's todo board, resolved for one parent Session — the unit the
 * Side pane renders as a labelled block (Task 3). Carries BOTH counts so the
 * block never re-counts (`completed` for the `n/m` denominator, `open` for the
 * numerator), and BOTH names so a click-through can route on the id while the
 * heading shows the disambiguated label.
 */
export interface TodoBoard {
  /** The SUBAGENT session id — the key `useSubagentSelection.select` routes on. */
  childSessionId: string;
  /** `SubagentEntry.agentName`, verbatim. */
  agentName: string;
  /** `agentName`, plus `" 2"`, `" 3"`… in arrival order ONLY when a sibling shares the name. */
  label: string;
  /**
   * The child's full list, straight from the store (never copied, never
   * filtered): REDUCED vs FULL is a render choice the pane makes
   * (`CONTEXT.md`), and the store always holds the full list.
   */
  items: TodoItem[];
  completed: number;
  /** The OPEN (non-`completed`) count — the visibility rule, and the block's `n/m` numerator. */
  open: number;
  /** `SubagentEntry.startedAt` — the sort key (child arrival). */
  startedAt: number;
}

/** The answer when there is no Session to scope to — ONE frozen array, so
 * "no boards" is referentially stable across renders and a consumer that tried
 * to mutate the shared instance throws instead of corrupting every other
 * render (the `NO_GATES` pattern in `useChildGates`). */
const NO_BOARDS: TodoBoard[] = [];
Object.freeze(NO_BOARDS);

/**
 * The ONE derivation of "which todo boards do the RUNNING children of THIS
 * Session have, in arrival order, labelled so two same-named children are
 * distinguishable" — the Side pane's child blocks read it and nothing else, so
 * two surfaces cannot disagree (the standing rule `useSessionStatus` /
 * `useBoardOpenCount` exist to enforce). `useChildGates` is the house shape:
 * a pure core over the stores' slices plus a parent id, a thin hook over that,
 * and a frozen empty array for "nothing".
 *
 * The PURE core is exported because a hook cannot be called once per parent at a
 * changing list length, and a component must not read two stores ad hoc. It
 * holds no React and reads no store: the tests drive it directly.
 *
 * Its rules, in order:
 *
 * 1. `parentSessionId === null` → `NO_BOARDS`. THIS IS NOT `childGatesOf`'s
 *    `null`: there, `null` means "EVERY child", because the always-mounted
 *    `SubagentModals` overlay genuinely needs the unscoped set. Here it means
 *    "there is no active Session", and no caller wants an app-wide bag of every
 *    child's checklist — the pane is scoped to one Session by definition. The
 *    asymmetry is pinned by a test on each side so nobody "fixes" one to match
 *    the other.
 * 2. Only the entry's own children (`entry.parentSessionId === parentSessionId`):
 *    another Session's board belongs in THAT pane.
 * 3. Only `status === "running"`. A child that completed, failed or was
 *    cancelled stops taking space in the pane; the block disappearing IS the
 *    cleanup. Its outcome does not need this surface to stay visible — it reads
 *    in the `SubagentDelegatingCard` in the parent's transcript and in the
 *    child's own sheet — and keying on `running` means the derivation needs no
 *    close frame behind it (a child's slice is cleared narrowly by the
 *    `subagent-closed` handler, `App.tsx`, but this rule does not depend on that
 *    write having arrived).
 * 4. `items = todos[entry.sessionId] ?? []`, and an entry whose list has NO open
 *    item is skipped: an all-completed child list renders nothing, which is the
 *    visibility rule the parent's own list already obeys
 *    (`useBoardOpenCount` counts a fully-completed list as ZERO), so the two
 *    halves of the pane cannot disagree about what "has a board" means.
 * 5. Sorted by `startedAt` ASCENDING — child ARRIVAL. `Object.values`' insertion
 *    order is only the tie-breaker (and it happens to be arrival order too,
 *    because `useSubagents.entries` is keyed by child id in arrival order); the
 *    KEY is the wall clock, so a re-delivered `subagent-session-started` that
 *    keeps the original `startedAt` does not reorder the blocks.
 * 6. Labels are counted within the RENDERED set — the set rules 2–4 left alive,
 *    in the arrival order rule 5 produced. A name used once stays bare; a name
 *    used K times stays bare on its first arrival and gets `" 2"`, `" 3"`… on the
 *    next. Counting over the rendered set rather than over every entry is what
 *    keeps a lone visible `researcher` bare when its sibling belongs to another
 *    Session or already finished — a suffix that indexes a block the user cannot
 *    see would be noise dressed as precision.
 * 7. A child with no `todos_update` board has no board here, full stop.
 *    Boards come from session state (`useInteractive.todos[entry.sessionId]`),
 *    never from transcript scans.
 */
export function todoBoardsOf(
  entries: Record<string, SubagentEntry>,
  todos: Record<string, TodoItem[]>,
  parentSessionId: string | null,
): TodoBoard[] {
  // Rule 1 — see the doc block: `null` is "no Session", never "every child".
  if (parentSessionId === null) return NO_BOARDS;

  const boards: TodoBoard[] = [];
  for (const entry of Object.values(entries)) {
    // Rules 2 and 3, cheapest and most selective first.
    if (entry.parentSessionId !== parentSessionId) continue;
    if (entry.status !== "running") continue;
    // Rule 4. The default lives HERE, never as a `?? {}` on the store slice in a
    // selector (which would mint a fresh object per read and re-render forever).
    const items = todos[entry.sessionId] ?? [];
    let completed = 0;
    for (const item of items) {
      if (item.status === "completed") completed++;
    }
    const open = items.length - completed;
    if (open === 0) continue;
    boards.push({
      childSessionId: entry.sessionId,
      agentName: entry.agentName,
      // Provisional: rule 6 overwrites it for a name the rendered set repeats.
      label: entry.agentName,
      items,
      completed,
      open,
      startedAt: entry.startedAt,
    });
  }

  // Rule 5. `Array.prototype.sort` is stable, so children that arrived in the
  // same millisecond keep the `Object.values` (insertion = arrival) order.
  boards.sort((a, b) => a.startedAt - b.startedAt);

  // Rule 6, over the sorted set. `totals` answers "is this name repeated at all"
  // (a repeated name's FIRST arrival stays bare — only the later ones need to be
  // told apart from it), `seen` is the arrival index that supplies the suffix.
  const totals = new Map<string, number>();
  for (const board of boards) {
    totals.set(board.agentName, (totals.get(board.agentName) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  for (const board of boards) {
    const nth = (seen.get(board.agentName) ?? 0) + 1;
    seen.set(board.agentName, nth);
    if (nth > 1 && (totals.get(board.agentName) ?? 0) > 1) {
      board.label = `${board.agentName} ${nth}`;
    }
  }
  return boards;
}

/**
 * The boards the RUNNING children of ONE Session have, in arrival order and
 * labelled (see `todoBoardsOf`, whose rules this is a thin read of the two
 * stores over). `parentSessionId === null` → `NO_BOARDS`.
 */
export function useTodoBoards(parentSessionId: string | null): TodoBoard[] {
  // Selectors return the STORE's own slices — never a `?? {}` fallback inside a
  // selector, which would mint a new object per call and re-render forever (the
  // hazard `useMainTodoItems`, `useSessionStatuses` and `useChildGates` each
  // document). Defaults live OUTSIDE the selector, in `todoBoardsOf`'s rule 4.
  const entries = useSubagents((s) => s.entries);
  const todos = useInteractive((s) => s.todos);
  // MEMOISED on exactly the three values this hook subscribes to, so the
  // derivation re-runs only when its inputs could have changed and the pane gets
  // a stable array across renders that touched neither store (the Side pane
  // re-renders on every streamed token, and `todoBoardsOf` allocates).
  //
  // `useMemo` is a hint React may in principle discard, so no consumer may read
  // the array's identity as CORRECTNESS — only as "this render did not
  // re-derive". `NO_BOARDS` is the one exception, and it is safe because it is a
  // module constant rather than a memo result.
  return useMemo(() => {
    if (parentSessionId === null) return NO_BOARDS;
    return todoBoardsOf(entries, todos, parentSessionId);
  }, [entries, todos, parentSessionId]);
}
