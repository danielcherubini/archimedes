import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useTodoBoards } from "../hooks/useTodoBoards";
import { basenameOfPath } from "../lib/paths";
import { sessionFieldOf } from "../lib/sessionLookup";
import { useSessions } from "../store/sessions";
import {
  getSidePaneCollapsed,
  setSidePaneCollapsed,
  SIDE_PANE_RAIL,
  subscribeSidePane,
} from "../lib/sidePaneState";
import TodoBoardPanel, { useBoardOpenCount, useMainTodoItems } from "./TodoBoardPanel";
import { cn } from "./lib/utils";
import TodoRail from "./TodoRail";
import SessionConfigBlock from "./SessionConfigBlock";
import { SessionCostLine } from "./SessionCostLine";

const WIDTH_KEY = "side-pane-width";
const MIN_WIDTH = 240;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 320;

function clampWidth(w: number): number {
  return Math.min(Math.max(w, MIN_WIDTH), MAX_WIDTH);
}

function initialWidth(): number {
  const stored = localStorage.getItem(WIDTH_KEY);
  if (stored === null) return DEFAULT_WIDTH;
  const n = Number(stored);
  if (!Number.isFinite(n)) return DEFAULT_WIDTH;
  return clampWidth(n);
}

/**
 * The right-hand side pane: a 320px-default resizable + collapsible frame
 * hosting a STATUS PANEL (the ZCode `ConversationStatusPanel` treatment —
 * NOT a tabbed sidebar): a single data-gated section in one content
 * area, rendering only while it has something to show:
 *
 * - **Todo boards** (`TodoBoardPanel`): the `Todos` label + `N/M` +
 *   progress header, the parent's checklist, and one labelled block per
 *   running **Subagent session** that has a board — hidden while NO board has
 *   an open item (no todos at all, or every list fully completed; the
 *   `useBoardOpenCount` derivation, which counts the parent's list PLUS every
 *   running child's).
 *
 * - **Auto OPEN (the "popup" rule, ADR 0042): the frame EXPANDS when open
 *   todos go 0 → >0 (the parent's own list or a running Subagent session's)
 *   and NEVER collapses itself.** A board FINISHING (`visible` back to 0) leaves
 *   the frame OPEN with the data-gated Todos section gone and the session title
 *   still there: yanking the surface that just showed the work out from under
 *   the user is the exact behavior that was reported, and now that every running
 *   child's board counts, a 1 → 0 dip that means "one child finished while its
 *   siblings work" is routine. So the collapse arm is deleted — the user's own
 *   toggle is the ONLY thing that closes the frame, and nothing in this
 *   component ever writes the flag `true`.
 *   The pane still opens on TODO BOARDS ONLY — a child session opens it through
 *   its own board and nothing else (a child with no board opens nothing; the
 *   subagents live under the "Delegating" card + the child's
 *   transcript SHEET (`SubagentDetailHost`); their gates never render in this
 *   pane either — they are inline in the parent's transcript or hosted by
 *   `SubagentModals`, neither of which the pane mounts).
 *   The trigger stays EDGE-TRIGGERED (a `prevVisible` ref): a MANUAL
 *   collapse while `visible` is unchanged is respected — a count
 *   change without the edge never flips the flag (that is what keeps a
 *   collapse during in-flight work from being undone by later todo updates).
 *   A SESSION SWITCH is not an edge: when the active session changes, the
 *   previous-visible ref is re-baselined to the new session's `visible` and the
 *   flag is never written — a board that was already open in the session the user
 *   landed on did not appear in front of them, and the flag is app-global while
 *   `visible` is per-session. The HYDRATION GAP that follows a switch is not an
 *   edge either: `openSession` flips the id before `loadHistory` lands the
 *   history, and a stored session's board is seeded on that history load, so
 *   the re-baseline holds until the session's messages exist (a live session's
 *   are already `[]`) — otherwise the frame popped open a tick after the switch.
 * - **Collapse mechanism: the frame's `SIDE_PANE_RAIL` (a sliver, NOT 0) +
 *   `overflow: hidden` — NOT `display: none`, NOT a transform, NOT unmount.**
 *   The pane's OWN content (its toggle, the board and the board's scroll
 *   position) stays MOUNTED and simply clipped, so re-opening never rebuilds it
 *   and the toggle never leaves the cursor. (A pending subagent gate survives
 *   a collapse too, but no longer because of this paragraph: the gate host
 *   `SubagentModals` is mounted at the `App` root, so
 *   it was never inside the clipped frame to begin with.)
 *   The pane holds NO collapse control: its toggle lives in the chrome bar's
 *   `ChromeControls`, beside the window controls, in both states (there is no
 *   keyboard shortcut for this pane, and none is needed — the button is always
 *   on screen). The collapsed flag is shared via `sidePaneState`: the module
 *   seeds the flag from `localStorage` at import (it is the single persistence
 *   owner) — `SidePane` READS it via `useSyncExternalStore`, and the only
 *   writers are that chrome-bar toggle and the auto-open edge below, which can
 *   only ever write `false`.
 * - **Resize:** a 4px drag handle on the frame's left edge (a `w-1`
 *   `cursor-col-resize` div, transparent hit area — a 2px
 *   `bg-foreground-subtlest/50` line shows on hover/while dragging). The
 *   width is clamped 240–480px; the live state updates on every
 *   `mousemove`, but the width is flushed to `localStorage`
 *   (`"side-pane-width"`) on `mouseup` only (NOT on every `mousemove` —
 *   ~60/s sync writes). The handle captures the pointer on `pointerdown`
 *   (released on `pointerup`/`pointercancel`) so a release outside the
 *   webview still ends the drag; a `blur` listener is the fallback.
 */
export default function SidePane() {
  const [width, setWidthState] = useState(initialWidth);
  // The shared collapsed flag (the module seeds it from localStorage at
  // import). This component READS it for the frame's width — the
  // `SIDE_PANE_RAIL` sliver while collapsed, NOT 0. It WRITES it in exactly one
  // place, the auto-open edge below, which can only ever write `false`: closing
  // the frame is the chrome bar toggle's job alone (ADR 0042 — the pane opens
  // itself and never closes itself), and that control now sits outside this
  // component, so nothing in this file renders it.
  const collapsed = useSyncExternalStore(
    subscribeSidePane,
    getSidePaneCollapsed,
  );

  // Live width state (the drag updates it on every `mousemove`); `widthRef`
  // mirrors it so the `mouseup` flush reads the latest value (the drag
  // effect's closure would be stale).
  const widthRef = useRef(width);
  const setWidth = useCallback((w: number) => {
    const clamped = clampWidth(w);
    widthRef.current = clamped;
    setWidthState(clamped);
  }, []);

  // The drag (track `mousemove` on `window` while dragging; the handle
  // captures the pointer so a release outside the webview still delivers
  // the `pointerup` — a `blur` listener is the fallback).
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  const handleRef = useRef<HTMLDivElement>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragStart.current = { x: e.clientX, width };
    setDragging(true);
    // Capture the pointer: the `pointerup` is delivered to the handle even
    // if the mouse is released outside the webview (it does NOT get lost).
    // (`pointerdown` is the only DOM event carrying `pointerId` — a
    // `mousedown` handler could not capture.)
    handleRef.current?.setPointerCapture(e.pointerId);
  };

  useEffect(() => {
    if (!dragging) return;
    // End the drag: clear `dragging` and flush the width to localStorage
    // ONCE (NOT on every `mousemove` — ~60/s sync writes). A
    // quota/lockdown throw is best-effort (the live width stays in state).
    const endDrag = () => {
      if (!dragStart.current) return;
      dragStart.current = null;
      setDragging(false);
      try {
        localStorage.setItem(WIDTH_KEY, String(widthRef.current));
      } catch {
        // persistence is best-effort; the width lives on in state
      }
    };
    const onMove = (e: MouseEvent) => {
      const start = dragStart.current;
      if (!start) return;
      // The handle is on the frame's LEFT edge: dragging LEFT widens.
      setWidth(start.width - (e.clientX - start.x));
    };
    const onPointerEnd = (e: PointerEvent) => {
      // `endDrag` FIRST: if `releasePointerCapture` throws (an expired
      // `pointerId` / a non-compliant webview) the drag must still end —
      // otherwise `dragging` sticks and the width never flushes. (It is
      // idempotent via the `dragStart` guard: a later `mouseup` is a no-op.)
      endDrag();
      try {
        handleRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        // capture already expired — the drag is ended above
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", endDrag);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    // The pointer is lost (released outside the webview): `blur` clears
    // `dragging` (it does NOT stick).
    window.addEventListener("blur", endDrag);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", endDrag);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      window.removeEventListener("blur", endDrag);
    };
  }, [dragging, setWidth]);

  // The data: the resolved WHOLE-BOARD OPEN todo count for the active
  // session — the parent's list plus every running child's — the SAME
  // derivation the Todos section's own gate uses (`useBoardOpenCount`), so the
  // frame can never open on a section that renders nothing, nor hide one that
  // has something to show.
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const boardCount = useBoardOpenCount(activeSessionId);
  // The rail's two inputs, both read ONCE here (`mainTodoItems` below, `boards`
  // further down): the FULL main list (completed included) PLUS one entry per
  // running child that has a board. The open count drives the pane, the whole
  // list plus the child boards drive the rail, so a finished parent run still
  // reads as a tick in the sliver and every child board still gets its own mark.
  const mainTodoItems = useMainTodoItems(activeSessionId);
  // The running children that have a board (arrival order, labelled). Read
  // ONCE here and handed to the rail: `useBoardOpenCount` above derives the
  // count from the same hook, so the frame's gate and the rail's marks are the
  // SAME set of boards by construction. That is the point of sharing the HOOK,
  // and it is not a call-count argument — the call count is not one. THREE
  // `useTodoBoards` instances live in this subtree: this one, the one inside
  // `useBoardOpenCount` (it needs the boards for its own total), and
  // `TodoBoardPanel`'s — which mounts unconditionally, so its hooks run on every
  // pass even when it returns `null`. Each is a separate `useMemo` recomputing on
  // its OWN deps, not on every render of the pane (a token stream that touched
  // neither store re-derives nothing). So the number of derivations is beside the
  // point; what sharing the hook buys is that all three defer to the ONE
  // `todoBoardsOf`. That is why the rail is handed the value instead of deriving
  // it locally: a hand-written rail would be a fourth place that decides which
  // children have a board, and the first thing to drift when the rule changes.
  const boards = useTodoBoards(activeSessionId);

  // The session title (the top section — the old chat header's title moved
  // here, the header is gone): the session's GENERATED title when the naming
  // pass wrote one (`SessionInfo.title`, auto-generated only), else the first
  // `user` message truncated to ~80 chars (the SAME derivation the header +
  // the sidebar rows use), else the Space's base name (the active session's
  // `cwd` — live, stored, OR archived membership; `basenameOfPath` of it — a
  // session whose cwd is no known Space still shows its folder's base name).
  const activeMessages = useSessions((s) =>
    s.activeSessionId ? s.messages[s.activeSessionId] : undefined,
  );
  // The active session's `cwd` and its generated `title`, each read by its OWN
  // selector over the ONE three-list walk (`lib/sessionLookup.ts`). They are
  // deliberately TWO selectors and not one returning `{ cwd, title }`: zustand
  // v5 re-runs a selector that yields a FRESH OBJECT on every snapshot read, so
  // the pane would re-render forever (`useShallow` would fix it; two primitive
  // selectors are cheaper and match the shape of this file).
  const activeCwd = useSessions((s) =>
    sessionFieldOf(s, s.activeSessionId, "cwd"),
  );
  // `?? null` is KEPT, not delegated: `sessionFieldOf`'s empty case is
  // `undefined` and this selector's contract was `string | null` — the header's
  // `sessionTitle` chain below tests `storedTitle !== null` to tell "no title"
  // apart from nothing else. Collapsing the two would change what the guard
  // means, so the null stays owned here (the same reason
  // `sessionConfigOptionsOf` keeps its own `?? null` tail).
  const storedTitle = useSessions(
    (s) => sessionFieldOf(s, s.activeSessionId, "title") ?? null,
  );
  // (`find` does not narrow its result — the `kind` check on the found
  // value, THEN the `text` access, is the ChatStream pattern.)
  const firstUserMessage = activeMessages?.find((m) => m.kind === "user");
  const firstUserText =
    firstUserMessage && firstUserMessage.text !== ""
      ? firstUserMessage.text
      : undefined;
  // The title SHORT-CIRCUITS the chain: a session the naming pass titled is
  // labelled by that title, never by a prompt truncation. (`""` is treated as
  // no title — the backend never writes one, but an empty label would render
  // an invisible header.)
  const sessionTitle =
    storedTitle !== null && storedTitle !== ""
      ? storedTitle
      : firstUserText
        ? firstUserText.length > 80
          ? firstUserText.slice(0, 80)
          : firstUserText
        : activeCwd
          ? basenameOfPath(activeCwd)
          : null;

  // The auto OPEN (the "popup" rule — see the component doc; ADR 0042): the
  // frame EXPANDS on the 0 → >0 edge of `visible` (open todos — the parent's
  // list plus every running child's) and is NEVER collapsed by this effect.
  // The `prevVisible` ref keeps it EDGE-TRIGGERED: a change while `visible`
  // is unchanged never touches the flag, so a MANUAL collapse during in-flight
  // work survives every later todo update. The pane still opens on TODO BOARDS
  // ONLY (a child session opens it through its own board and nothing else —
  // starting a child that has written no list opens nothing; the subagents
  // otherwise live under the "Delegating" card + the child's transcript SHEET).
  // A SESSION SWITCH is not an edge either (see `prevSessionIdRef` below), and
  // neither is the hydration gap that follows one: the session switched TO has
  // no transcript yet, so its board is not knowable and the re-baseline holds
  // until it is (see `hydrated`).
  const visible = boardCount > 0;
  const prevVisibleRef = useRef(visible);
  // The session `prevVisibleRef` describes. `visible` is PER-SESSION (it reads
  // `activeSessionId`) while the collapsed flag is APP-GLOBAL — it is the value
  // `localStorage` persists, and it survives every navigation. So switching to
  // a session that already has an open board moves `visible` `false → true` all
  // on its own: `!was && visible` would fire and pop the frame open against the
  // collapse the user chose, over a board that appeared somewhere they were not
  // even looking a moment ago. Since child boards count (ADR 0041) that is the
  // COMMON case — a delegation in another session would open this pane.
  // A switch is therefore NOT "a board appearing": the effect re-baselines the
  // ref to the new session's visibility and returns without touching the flag.
  // ADR 0042's two rules are untouched by this — the effect still ONLY ever
  // opens, and still never collapses itself; it simply keeps judging edges
  // within the session the user is actually looking at.
  const prevSessionIdRef = useRef(activeSessionId);
  // A switch is not an edge — and the session switched TO may still be hydrating
  // (`openSession` flips `activeSessionId` synchronously and loads the
  // transcript LATER, `void (async () => loadHistory(sessionId))`), so its board
  // is not knowable at the instant of the switch. Keep re-baselining until that
  // transcript exists; a live session's array is already `[]` (`addSession`
  // writes it, and `selectSpace`/`setSpaces`/`resumeSession` all go through
  // `openSession`/the history reload), so only un-hydrated sessions extend this.
  // Not academic: `useInteractive.todos` is seeded when the session hydrates,
  // so landing on a stored session must not pop the frame when its history arrives.
  const hydrated = activeSessionId !== null && activeMessages !== undefined;
  // Whether the pass being COMPARED was hydrated too, not just this one. The
  // transcript and the board it seeds land in the SAME RENDER PASS: the write is
  // ONE (`loadHistory` sets `messages[sessionId]` and seeds `todos`), so
  // `hydrated` and `visible` flip in ONE commit: comparing that pass against
  // the pre-hydration baseline reads as a `false → true` arrival and is the
  // exact pop this re-baseline exists to prevent. So the gap closes on the pass
  // AFTER the transcript lands — and a board that appears after that is a
  // genuine edge again.
  // NOTE on the guard below: the `!hydrated` term is ONE NO TEST CAN REACH ON
  // ITS OWN. An active session's `messages` are never removed while it stays
  // active (hydration is monotone per session), so an un-hydrated pass always
  // finds `prevHydratedRef` un-hydrated too — the ref arm already implies it,
  // and deleting `!hydrated` leaves the suite green. It is KEPT so the rule
  // reads whole ("both the pass in hand and the pass being compared must be
  // hydrated") rather than leaving half of it to be inferred from that
  // invariant; it is belt-and-braces, not a coverage hole to chase.
  const prevHydratedRef = useRef(hydrated);
  useEffect(() => {
    if (
      prevSessionIdRef.current !== activeSessionId ||
      !hydrated ||
      !prevHydratedRef.current
    ) {
      prevSessionIdRef.current = activeSessionId;
      prevHydratedRef.current = hydrated;
      prevVisibleRef.current = visible;
      return;
    }
    const was = prevVisibleRef.current;
    prevVisibleRef.current = visible;
    // Edge-triggered OPEN only (ADR 0042). Nothing here may collapse the pane:
    // `visible` going 1 → 0 is a board FINISHING, which is not a reason to hide the
    // surface that just showed it — the user's toggle is the only thing that closes
    // the frame. The ref survives for the MOUNT edge: with todos already open and
    // the pane collapsed (localStorage said collapsed), `was === visible === true`
    // must NOT re-expand — that is the `does NOT auto-expand on mount when todos
    // already exist` case. Mount is a non-edge because `useRef(visible)` SEEDS the
    // ref with the FIRST render's `visible` (the two guards above are seeded the
    // same way, with the first render's id and hydration state), so the first pass
    // compares a value against itself and neither guard fires on it.
    if (!was && visible) setSidePaneCollapsed(false);
  }, [visible, activeSessionId, hydrated]);

  return (
    // Collapse = `SIDE_PANE_RAIL` (a 40px sliver, NOT 0) + `overflow: hidden`
    // — the content stays MOUNTED and is CLIPPED, which is what keeps the
    // board's scroll position (and everything else that lives in that subtree)
    // across a collapse. The sliver is not merely empty space: it is the room
    // the collapsed rail's marks (`TodoRail`) draw in — one per todo board,
    // because the clipped board cannot render in 40px.
    <div
      style={{ width: collapsed ? SIDE_PANE_RAIL : width }}
      className="relative m-1 flex shrink-0 flex-col overflow-hidden rounded-xl bg-inspector"
    >
      {/* The 4px drag handle (left edge): transparent hit area, a 2px
          `bg-foreground-subtlest/50` line on hover / while dragging.
          Hidden while collapsed: the collapsed width is the fixed
          `SIDE_PANE_RAIL`, not the dragged value, so there is nothing to
          resize here. */}
      {!collapsed && (
        <div
          ref={handleRef}
          className="absolute inset-y-0 left-0 w-1 cursor-col-resize"
          onPointerDown={onPointerDown}
        >
          <div
            // `opacity-100` / `opacity-0` are one tailwind-merge group and the two
            // arms are mutually exclusive, so the merge is the identity here
            // (`SidePane.test.tsx` anchors on the END of the attribute —
            // `/ opacity-100$/` — and `cn` emits no trailing space, so that pin
            // holds either way).
            className={cn(
              "h-full w-0.5 bg-foreground-subtlest/50",
              dragging ? "opacity-100" : "opacity-0 hover:opacity-100",
            )}
          />
        </div>
      )}
      {/* The STATUS PANEL (the ZCode `ConversationStatusPanel`
          treatment): the data-gated sections stacked in one content
          area (no tabs). ALWAYS MOUNTED — collapse clips it (the 40px
          rail + `overflow: hidden`), it is NOT unmounted (the local UI
          state — section open/closed, scroll — survives a collapse).

          `invisible` WHILE COLLAPSED is load-bearing. Clipping alone let the
          board paint INTO the 40px sliver: labels wrapped to one character per
          line ("th / so / is / s …") inside their own `overflow-y-auto`, which
          then grew a SCROLLBAR in the sliver. `visibility: hidden` takes the
          element AND ITS SCROLLBAR out of the paint while leaving the layout
          untouched, so the content stays mounted (and its scroll position
          survives) — `hidden` would unlayout it. The rail's per-board marks
          (below) are what show in its place. */}
      <div
        className={cn(
          "flex-1 overflow-y-auto p-3",
          // `invisible` (visibility) is its own tailwind-merge group, so nothing
          // here is dropped; see the long comment above the wrapper for why the
          // utility is `invisible` and not `hidden`.
          collapsed && "invisible",
        )}
      >
        <div className="flex flex-col gap-4">
          {/* The session title (the old header's title — the header is
              gone, the title lives here): the generated title when there is
              one, else the first `user` message truncated to ~80 chars, else
              the Space's base name. The same gradient-fade mask the header
              used (background-agnostic). */}
          {sessionTitle !== null && (
            <div
              className="min-w-0 text-ui-base font-medium text-foreground"
              style={{
                maskImage:
                  "linear-gradient(to right, black calc(100% - 1.5rem), transparent)",
                WebkitMaskImage:
                  "linear-gradient(to right, black calc(100% - 1.5rem), transparent)",
              }}
            >
              {sessionTitle}
            </div>
          )}
          {/* The session's cumulative USD figure (#87), directly under the title
              and above the todo board. It renders NOTHING — no element, so no
              `gap-4` slot either — unless some call this session made reported a
              cost, which is the ordinary case (absence is per-CALL). The line
              itself owns the money rules; nothing is decided here. */}
          <SessionCostLine sessionId={activeSessionId} />
          {/* The todo boards (data-gated by `TodoBoardPanel` — it renders
              `null` while NO board (the parent's list or a child's) has an open
              item, the same rule `boardCount` above reads). */}
          <TodoBoardPanel sessionId={activeSessionId} />
        </div>
      </div>
      {/* The session's config lines (Model / Reasoning / Context) — the lines
          that left the composer's bottom row. Mounted AFTER the scroll area:
          inside the scroller the block would scroll away with a growing todo
          board, and before the scroller it would sit above the title. The Model
          line and the context bar are NEVER data-gated (unlike the todo
          section); the Reasoning line renders only when the session's options
          carry a `thought_level` select. So with no active session the block is
          the Model stub and an empty 0% track. `collapsed` is
          passed rather than re-read — the block lives outside the scroller, so
          the scroller's `invisible`-while-collapsed class cannot reach it and it
          needs its own (see `SessionConfigBlock`). */}
      <SessionConfigBlock collapsed={collapsed} />
      {/* The collapsed rail's board marks: one tick or dot per BOARD (the
          parent's list, then one per running child), because a 40px sliver can
          hold the SHAPE of a board and nothing else. Rendered only while
          collapsed (the open pane already shows the boards, and a second copy
          of them would be a second thing to keep in sync). */}
      {collapsed && <TodoRail mainItems={mainTodoItems} boards={boards} />}
    </div>
  );
}
