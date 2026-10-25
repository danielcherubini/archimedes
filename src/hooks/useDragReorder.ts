import { useCallback, useState } from "react";
import type { DragEventHandler } from "react";

/**
 * The drag gesture BOTH lists share — the sidebar's rows and the top tab strip —
 * owned once, here.
 *
 * It answers three questions and no caller answers any of them: what is being
 * dragged, which row is the drop target, and where does the dragged id land.
 * Two independent implementations of "compute the new index from a drop
 * position" is exactly the drift this repo documents elsewhere, so there is
 * exactly one copy of that arithmetic in `src/` and it is the private `moveId`
 * below.
 *
 * THE ROW IS THE TARGET. Drop lands ONTO a row and the pointer's half of that
 * row decides before-or-after; there are no gap targets and no placeholder rows,
 * because nothing new may need laying out in a list whose contract is one DOM
 * level (the row components' no-DOM-level rule, and the eight ancestry-resolving
 * test sites that depend on it).
 *
 * WHICH HALF IS READ OFF THE LIST'S OWN AXIS, and the list's axis is TOLD to the
 * hook (`axis`, default `"y"`), never inferred from the rect: see `DragAxis`.
 * Both lists share this one gesture and its arithmetic; they differ in exactly
 * one input, which axis the pointer travels along, and that is a fact about the
 * call site's layout rather than about the drag.
 *
 * It renders nothing, touches no DOM beyond `getBoundingClientRect()`, mutates no
 * class, and does not know what a list of ids MEANS — it takes `ids` and an
 * `onReorder`. That is also why it imports nothing but `react`: a `hooks/` module
 * that reached into a store would give "what is visible" a second owner, and the
 * `lib` layer's own header rule (no `lib → store` edge) exists to stop exactly
 * that kind of cycle.
 *
 * And it deliberately never halts an event's propagation: the window drop backstop
 * (`useWindowDropBackstop`) listens on `window` and the row's handler fires
 * first during bubbling, so the row wins the drop on its own — and a release
 * outside any row still reaches the backstop, which is the only thing standing
 * between a stray drop and the webview NAVIGATING to it.
 */

/** Which half of the target row the pointer is in — the answer that decides
 *  EARLIER or LATER in the list.
 *
 *  AXIS-NEUTRAL ON PURPOSE. "before" means EARLIER in the ids array, which in a
 *  VERTICAL list is ABOVE and in a HORIZONTAL strip is to the LEFT. The hook
 *  answers the ordering question only; which physical border paints it is the
 *  CALL SITE's choice, because only the call site knows how its list is laid
 *  out (the sidebar draws `border-t-2`/`border-b-2`, the tab strip
 *  `border-l-2`/`border-r-2`). Moving that choice in here would give the hook an
 *  opinion about markup, which is the same category error as it computing a
 *  class. */
export type DropEdge = "before" | "after";

/** The axis the pointer's half is read off. `"y"` for a VERTICAL list (the
 *  sidebar's rows), `"x"` for a HORIZONTAL one (the tab strip).
 *
 *  EXPLICIT, NEVER INFERRED. The tempting implementation — compare the rect's
 *  `width` to its `height` and guess — is wrong and fails SILENTLY in the
 *  direction that matters: a sidebar row is wider than it is tall (measured: the
 *  rows fill a 260px pane at ~40px high), so a proportion heuristic would flip
 *  the SIDEBAR onto the X axis and break the list that has always worked. Only
 *  the call site knows how its own list is laid out, so only the call site says
 *  which axis it is on. */
export type DragAxis = "x" | "y";

/** THE spread surface. `RowButton` emits `...rest` verbatim and its header pins
 *  attribute order as part of its contract, so this is EXACTLY six keys and no
 *  more (pinned by the first test in `useDragReorder.test.tsx`). */
export interface DragReorderHandlers {
  draggable: true;
  onDragStart: DragEventHandler<HTMLDivElement>;
  onDragEnd: DragEventHandler<HTMLDivElement>;
  onDragOver: DragEventHandler<HTMLDivElement>;
  onDragLeave: DragEventHandler<HTMLDivElement>;
  onDrop: DragEventHandler<HTMLDivElement>;
}

export interface UseDragReorder {
  /** Spread onto the row. `draggable: true` plus the five handlers, nothing else. */
  dragProps: (id: string) => DragReorderHandlers;
  /** The row under drag, or `null`. */
  draggingId: string | null;
  /** The row currently offered as the drop target, or `null`. Never `draggingId`. */
  overId: string | null;
  /** Which half of `overId` the pointer is in — so a call site adds ONE class and zero logic. */
  overEdge: DropEdge | null;
}

/** The id's new position, given the target and the pointer's half. Pure, and the
 *  ONLY copy of the arithmetic in `src/`: both call sites go through it, which is
 *  the point of this hook. It stays module-private on purpose — exporting it
 *  would hand every call site a way to reorder a list without the gesture. */
function moveId(
  ids: readonly string[],
  draggingId: string,
  overId: string,
  edge: DropEdge,
): string[] {
  const rest = ids.filter((x) => x !== draggingId);
  const target = rest.indexOf(overId);
  if (target === -1) return [...ids];
  const at = edge === "before" ? target : target + 1;
  return [...rest.slice(0, at), draggingId, ...rest.slice(at)];
}

export function useDragReorder(args: {
  /** The visible slice, in its current order — the call site's list, whatever it means. */
  ids: readonly string[];
  /** Called with the WHOLE slice in its new order (never just the moved id): the backend
   *  writes the slice index as each row's stored order number, so a partial list is a
   *  half-moved list. */
  onReorder: (ids: string[]) => void;
  /** The axis the drop edge is read off. DEFAULTS TO `"y"`, so a vertical list
   *  passes nothing and keeps the exact behaviour it had before this option
   *  existed; the horizontal tab strip passes `axis: "x"`.
   *
   *  AN ARGUMENT, NEVER A SPREAD KEY. `dragProps` returns exactly six keys
   *  (`draggable` + five handlers) and its consumer spreads them VERBATIM onto a
   *  byte-compared row, so an axis key in there would be an unknown DOM
   *  attribute and would break `RowButton`'s attribute-order contract. Pinned by
   *  the first test in `useDragReorder.test.tsx`. */
  axis?: DragAxis;
}): UseDragReorder {
  const { ids, onReorder, axis = "y" } = args;
  // `useState`, not refs: the call site RENDERS the drop indicator from
  // `overId`/`overEdge`, so a ref would be invisible exactly where it is needed.
  // Handlers are rebuilt per render and close over THAT render's `ids` /
  // `onReorder`, which is correct rather than sloppy — a drag event is a discrete
  // task and React flushes state between two of them (measured: `dragStart`'s
  // setState is visible to the next dispatched `dragover`), so a drop always
  // reads the list as the last render showed it. No refs, no staleness dance.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [overEdge, setOverEdge] = useState<DropEdge | null>(null);

  const dragProps = useCallback(
    (id: string): DragReorderHandlers => ({
      draggable: true,
      onDragStart: (e) => {
        // Firefox starts no drag unless the payload is written. jsdom has no
        // DataTransfer, hence the optional chain — and the test that pins this
        // call is the only proof it survives in the real webviews. `getData` is
        // never read: the id lives in state and this is a single-window app, so
        // reading the payload would imply a cross-window drop nobody can serve.
        e.dataTransfer?.setData("text/plain", id);
        setDraggingId(id);
      },
      onDragEnd: () => {
        // Escape mid-drag fires `dragend` and NO `drop`, so this is the only
        // thing that can clear the gesture on that path. A lingering
        // `draggingId` would make the next `dragOver` think a drag is on.
        setDraggingId(null);
        setOverId(null);
        setOverEdge(null);
      },
      onDragLeave: () => {
        // Guarded, not unconditional: the browser fires `dragleave` on the OLD
        // row AFTER the `dragover` on the new one, so an unguarded clear flickers
        // the indicator off on every row-to-row move.
        if (overId === id) {
          setOverId(null);
          setOverEdge(null);
        }
      },
      onDragOver: (e) => {
        // A row is never a target for the drag it started: the spec's "dragging a
        // row onto itself is a no-op", and leaving the event UN-prevented is what
        // shows the browser's no-drop cursor and lets the backstop own the
        // release. With no drag on, the same reasoning applies.
        if (draggingId === null || draggingId === id) return;
        const rect = e.currentTarget.getBoundingClientRect();
        // THE AXIS, and the whole reason this option exists. A horizontal strip
        // holds `clientY` essentially constant across a drag, so reading the Y
        // midpoint there answers the side from WHERE IN THE PILL THE USER GRABBED
        // rather than from their left/right intent: a grab at the pill's vertical
        // centre answers "after" for every target, and a rightward drag onto its
        // left neighbour then produces the order the list already had — the
        // hook's "nothing moved" guard fires and the drag is a SILENT NO-OP.
        // (Leftward drags worked, by accident, which is how this survived review.)
        //
        // The `"y"` expression below is UNTOUCHED — same operands, same order,
        // same comparison — because the sidebar's rows must behave byte-forably
        // as they did before the option existed.
        const edge: DropEdge =
          (axis === "x"
            ? e.clientX < (rect.left + rect.right) / 2
            : e.clientY < (rect.top + rect.bottom) / 2)
            ? "before"
            : "after";
        // The line that makes this row a drop target at all.
        e.preventDefault();
        if (overId !== id) setOverId(id);
        if (overEdge !== edge) setOverEdge(edge);
      },
      onDrop: (e) => {
        const moved = draggingId;
        // The `ids.includes` half is the row that CLOSED mid-drag: its id is no
        // longer in the slice the last render showed, and moving an id the list
        // does not contain would either splice `undefined` in or fire an IPC with
        // a stale slice — both the half-moved list.
        if (moved === null || moved === id || !ids.includes(moved)) {
          // Deliberately NO `preventDefault` either: an inert release belongs to
          // the window backstop, which is what stops the webview navigating.
          setDraggingId(null);
          setOverId(null);
          setOverEdge(null);
          return;
        }
        e.preventDefault();
        const next = moveId(ids, moved, id, overEdge ?? "before");
        setDraggingId(null);
        setOverId(null);
        setOverEdge(null);
        // Nothing moved (a row nudged back onto its own boundary) costs no write.
        if (next.join("\u0000") !== ids.join("\u0000")) onReorder(next);
      },
    }),
    [draggingId, overId, overEdge, ids, onReorder, axis],
  );

  return { dragProps, draggingId, overId, overEdge };
}
