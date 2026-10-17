import { useMemo, useState } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import { basenameOfPath } from "../lib/paths";
import { titleFor } from "../lib/sessionTitle";
import { useSessions } from "../store/sessions";
import { useSessionStatuses } from "../hooks/useSessionStatus";
import { SessionStatusMark } from "./SessionStatusMark";
import type { SessionStatus } from "../hooks/useSessionStatus";
import CloseSpaceDialog from "./CloseSpaceDialog";
import { openNewSpaceDialog } from "../lib/newSpaceDialogState";

/**
 * A Space's own status, folded out of its live Sessions' statuses with the SAME
 * precedence `sessionStatusOf` gives one Session: `waiting` > `running` >
 * nothing to show.
 *
 * WHY `null` FOR IDLE AND STORED: a tab is not a session's only home — the
 * Space is a tab and its sessions are the rows below it, so the tab's job is
 * only to say "look up here". The sidebar row is where the idle/stored ring
 * belongs (it is the one place a stored session appears at all), and an idle
 * tab has always been blank. `live`/`stored` therefore pass through as `null`:
 * a Worker running and in an idle turn is not a fact the tab strip reports.
 *
 * Pure and exported so the precedence is assertable without the tab strip's
 * store fixtures.
 */
export function tabStatusOf(
  statuses: (SessionStatus | undefined)[],
): SessionStatus | null {
  if (statuses.includes("waiting")) return "waiting";
  if (statuses.includes("running")) return "running";
  return null;
}

/**
 * The Spaces as browser-style tabs (the top of the chat column — the old
 * session header row's position): one tab per Space (its base name), the
 * active one selected; clicking a tab selects the Space (the store's
 * `selectSpace` — its most recent session opens: live first, then the
 * newest stored). The `+` opens the New-Space dialog (picking a folder
 * IS creating a space — the same flow as the sidebar's `Open Space`), and it
 * opens it through the SHARED flag (`newSpaceDialogState`), because the tab
 * strip is not the dialog's owner — the flag has one, and this component is
 * not where it renders.
 *
 * The `...` menu (`New Session in this Space`) moved to the sidebar's
 * `Sessions` header (right-aligned, next to the word `Sessions`), and the
 * side-pane toggle moved to the `SidePane`'s footer — the tab bar is
 * tabs + `+` + a close control per tab.
 *
 * CLOSING A TAB (`×`, or the browser's middle-click) FORGETS the Space; it
 * deletes no conversation (`closeSpace` → `removeSpace`, which touches no
 * `sessions` row), so a quiet Space closes on the spot — re-opening the folder
 * puts the tab and its history back. A Space holding a LIVE `Session` is the
 * one case that asks, because the sidebar groups Sessions by Space: a closed
 * tab hides its Sessions while their Workers keep running, with no row left to
 * stop them from. `CloseSpaceDialog` offers Stop-and-close, Close-anyway and
 * Cancel.
 *
 * THE PILL IS A `div` WRAPPING TWO SIBLING BUTTONS (the tab, the ✕) — the ✕
 * cannot live INSIDE the `role="tab"` button, because an interactive child of a
 * button is removed from the accessibility tree (and `<button>`'s content model
 * forbids it): the tab would announce itself as one opaque control and the
 * close affordance would simply not exist to a screen reader. The wrapper
 * carries the pill's geometry and fill so the two still read as one object, and
 * it owns the middle-click (`mousedown` button 1) — a click on either child is
 * button 0, so the two paths cannot both fire. It also opts out of the window's
 * drag region explicitly (see the `data-tauri-drag-region` note on the pill):
 * the bar it sits in is a drag region, and a control must never be chrome.
 *
 * THE LEADING MARK is `SessionStatusMark` — the spinner for a Space whose
 * Worker is in a turn, the `?` for one blocked on the user (see
 * `tabStatusOf`). It is the SAME component the sidebar row and the collapsed
 * rail draw, which is the point: a `?` must not mean one thing in the tab and
 * something else two hundred pixels below it. Before it, the tab had a spinner
 * and NO waiting cue at all, so a Space parked on a permission looked identical
 * to one nobody had used in an hour.
 */
export default function SpaceTabs() {
  const spaces = useSessions((s) => s.spaces);
  const sessions = useSessions((s) => s.sessions);
  const activeSpacePath = useSessions((s) => s.activeSpacePath);
  const selectSpace = useSessions((s) => s.selectSpace);
  const closeSpace = useSessions((s) => s.closeSpace);
  const liveSessionIds = useMemo(
    () => sessions.map((s) => s.sessionId),
    [sessions],
  );
  const statuses = useSessionStatuses(liveSessionIds);
  // The tab awaiting confirmation: a Space with live Sessions cannot be
  // closed silently (see the header note). `null` = no dialog. The Sessions are
  // SNAPSHOTTED at request time — the dialog must not lose its subject if the
  // list churns underneath it (a Session closing its own turn while the
  // question is on screen) — and each carries its ID as well as its label, so
  // the confirm can stop exactly what it listed and key the list row even when
  // two Sessions share a label.
  const [closeTarget, setCloseTarget] = useState<{
    path: string;
    name: string;
    sessions: { id: string; label: string }[];
  } | null>(null);

  // A tab close, from either gesture: ask when the Space still holds open
  // Sessions, otherwise just do it.
  const requestClose = (path: string, name: string) => {
    const open = sessions.filter((s) => s.cwd === path);
    if (open.length === 0) {
      // A rejected close must be LOUD: the tab is still on screen (the command
      // failed, so the row is still there), and a tab that silently refuses is
      // indistinguishable from one that was never clicked. The repo's own rule
      // for a `void`ed command call (`SpacesList`'s archive / unarchive).
      void closeSpace(path).catch((err) => {
        console.error(`failed to close the ${path} tab:`, err);
      });
      return;
    }
    setCloseTarget({
      path,
      name,
      // Read from the store ON DEMAND, not subscribed: the tab bar would
      // otherwise re-render on every streamed token to label a dialog that is
      // open for one click. `messages` is only ever needed at this moment.
      sessions: open.map((s) => ({
        id: s.sessionId,
        label: titleFor(
          useSessions.getState().messages[s.sessionId],
          name,
          s.title,
        ),
      })),
    });
  };

  return (
    // The tabs live in the top CHROME BAR (the window titlebar row —
    // browser-style, like the reference screenshot): `h-full` (the bar
    // is 40px) + `flex-1` (fill the space between the logo segment and
    // the window controls). `pl-px`: the first tab sits 1px RIGHT of
    // the logo segment's right edge (the sidebar's 260px width) — the
    // user's "1px too far left" nudge. The tabs + `+` are left-aligned;
    // the empty strip after the `+` is just a spacer (the CHROME BAR
    // container itself is the drag region — the browser's empty tab
    // strip drags the window; double-click maximizes).
    <div
      className="flex h-full min-w-0 flex-1 items-center gap-1 pl-px pr-2"
      data-testid="space-tabs"
    >
      {spaces.map((s) => {
        const name = basenameOfPath(s.path) || s.path;
        const active = s.path === activeSpacePath;
        // The Space's OWN status, folded out of its live Sessions with the
        // SAME precedence `sessionStatusOf` uses for one Session: `waiting`
        // beats `running`. A Space with two Workers, one blocked on a
        // permission and one streaming, is blocked on YOU — and the spinner
        // would be the lie. `null` = nothing to report (no live session, or
        // live and idle), which is why the slot is a slot and not a dot: an
        // idle tab has always been blank here, and a tab that is a TAB needs no
        // idle mark (unlike a sidebar row, which is the only place its session
        // is listed).
        const tabStatus = tabStatusOf(
          sessions
            .filter((sess) => sess.cwd === s.path)
            .map((sess) => statuses[sess.sessionId]),
        );
        // ALL TABS ARE INSET PILLS — active and inactive share the pill
        // geometry (`h-8` inside the `h-10` bar, `rounded-md`). The active one
        // is the same pill lifted: a stronger fill (`bg-surface-hover` over
        // the `bg-surface` the inactive ones wear), full-contrast text and
        // `font-medium`. No bridge: this tab used to BE the sheet's top edge
        // (a full-height `rounded-t-md` tab with a hard 5px shadow merging it
        // into the chat slab) — the user found that a tab that is not the
        // same kind of object as its siblings read as inconsistent, so the
        // active tab is now the same pill, one step lifted.
        return (
          <div
            key={s.path}
            // The pill: ONE visual object, TWO sibling controls inside it.
            // The `max-w-48` cap is on the WHOLE pill and the ✕ takes 24px of
            // it (its `size-5` plus its `ml-1`), so a long folder name
            // truncates sooner than it did before the ✕ existed.
            //
            // `items-center` CENTRES the controls, and the label opts OUT with
            // `self-stretch`: the label is the surface the user aims at, so it
            // owns the `h-8` (a centred LINE left ~6px of bare pill above and
            // below it — dead pixels in a control), while everything else in
            // the pill is simply centred, so the ✕ needs no self-centring of
            // its own.
            //
            // `data-tauri-drag-region="false"`: the chrome bar this sits in is
            // `data-tauri-drag-region="deep"`, and Tauri's injected drag script
            // walks the event's composed path and stops at the FIRST element in
            // it that carries the attribute — an element with none is judged by
            // what it IS (a `BUTTON` / `role="tab"` is clickable, so it is
            // left alone; a bare `div` is not, so the press drags the window).
            // This wrapper is a bare `div`, so without the explicit `"false"`
            // every pixel of the pill the label does not cover was window-drag
            // surface. A tab is a control, not chrome: every pixel of the pill
            // selects or closes, and never drags.
            className={`flex h-8 max-w-48 items-center rounded-md ${
              active
                ? "bg-surface-hover"
                : "bg-surface hover:bg-surface-hover"
            }`}
            data-tauri-drag-region="false"
            onMouseDown={(e) => {
              // Middle-click anywhere on the pill closes the tab, as in every
              // browser. `button: 1` only — a left press belongs to whichever
              // control sits under it, and the right button belongs to the OS.
              // (The drag script never claims button 1, so this still fires
              // over the pill's `"false"` drag region, which only answers to
              // the left button.)
              // `preventDefault` is the part that matters on Windows: without
              // it WebView2 opens its autoscroll cursor over the tab strip, and
              // the middle-click selects instead of closing.
              //
              // THE LINUX CAVEAT, recorded as a decision and not an oversight:
              // the middle button is also X's primary selection, and the
              // PASTE of it happens on the middle *mouseup* at the pointer's
              // position — below the webview, in whatever the window happens to
              // be over. So a middle-click on a tab here can both close the tab
              // and paste the selected text into the app underneath. We keep
              // the close anyway: a tab that refuses to close because a paste
              // might follow is the worse of the two, and the paste is
              // recoverable while a stuck tab is not.
              if (e.button !== 1) return;
              e.preventDefault();
              requestClose(s.path, name);
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => selectSpace(s.path)}
              title={
                tabStatus === "waiting"
                  ? `${s.path} (waiting for you)`
                  : tabStatus === "running"
                    ? `${s.path} (working)`
                    : s.path
              }
              // `self-stretch` + `flex items-center`: the label owns the
              // pill's height and centres its own line (the wrapper centres the
              // OTHER child, not this one). `pl-3` is the pill's leading inset
              // and the ✕'s `mr-3` is its trailing one — the same value, so the
              // ✕ is not jammed against the edge while the label floats.
              // The text truncates on the `span` inside, not on this element:
              // `text-overflow` only renders an ellipsis for a box's own INLINE
              // content, and a flex container's bare text child is an anonymous
              // BLOCK item, so `truncate` here would clip long folder names
              // without ever showing the `…`.
              className={`flex min-w-0 self-stretch items-center gap-1.5 pl-3 text-ui-base ${
                active
                  ? "font-medium text-foreground"
                  : "text-foreground-subtle"
              }`}
            >
              {tabStatus !== null && (
                // The SAME glyph the sidebar row and the collapsed rail draw,
                // so a `?` means one thing in all three places: the spinner for
                // a Space that is working, the QUESTION for a Space blocked on
                // you. Rendered ONLY when there is something to report — the
                // spinner's rule before it — so an idle tab looks exactly as it
                // always did (an always-present empty slot would indent every
                // tab's label by a glyph's width).
                //
                // `active` drives the INK (brighter on the selected tab) rather
                // than being the session's own activity — the tab is the Space,
                // and the selected tab's glyph should not read dimmer than its
                // own label.
                //
                // NOT `aria-hidden` by default, but the tab passes
                // `announce={false}`: a name inside the tab button folds into
                // the tab's accessible name ("beta Waiting for you") and renames
                // the control mid-conversation, and this is the rule the tab's
                // spinner already followed (`aria-hidden`). The tab still names
                // the state, in its `title`. The sidebar ROW keeps the default
                // announcement — its text "Waiting" pill is gone.
                <SessionStatusMark
                  status={tabStatus}
                  active={active}
                  size={14}
                  testId="space-tab-mark"
                  announce={false}
                />
              )}
              <span className="truncate">{name}</span>
            </button>
            <button
              type="button"
              aria-label={`Close ${name}`}
              title="Close tab"
              onClick={() => requestClose(s.path, name)}
              // ALWAYS there — on the active tab and on every other one. The
              // first version drew it TRANSPARENT until the pointer reached the
              // pill, which made an un-hovered tab look un-closable (and left a
              // focusable control that could not be seen). It costs its 24px of
              // the `max-w-48` cap either way, so nothing is saved by hiding it.
              // `grid place-items-center` centres the glyph in the 20px square,
              // and the pill centres the square — no self-centring to get wrong.
              // `focus-visible:` mirrors the hover fill, so tabbing to the ✕
              // shows the same patch the pointer gets.
              className="ml-1 mr-3 grid size-5 shrink-0 place-items-center rounded text-foreground-subtle hover:bg-surface-hover focus-visible:bg-surface-hover hover:text-foreground focus-visible:text-foreground"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        aria-label="New space"
        onClick={openNewSpaceDialog}
        className="size-8 shrink-0 rounded-md text-foreground-subtle hover:bg-surface-hover"
      >
        <PlusIcon className="size-4" />
      </button>
      {/* The empty strip after the `+` (the browser's empty tab strip —
          a plain spacer; the chrome bar container is the drag region).
          */}
      <div className="flex-1" />
      {closeTarget && (
        <CloseSpaceDialog
          spaceName={closeTarget.name}
          sessions={closeTarget.sessions}
          onStopAndClose={() => {
            // Same rule as the ✕, and louder here: the dialog has already
            // closed itself, so an uncaught rejection would leave the user
            // with neither a closed tab nor an answer to the question.
            void closeSpace(
              closeTarget.path,
              closeTarget.sessions.map((s) => s.id),
            ).catch((err) => {
              console.error(`failed to close the ${closeTarget.path} tab:`, err);
            });
            setCloseTarget(null);
          }}
          onCloseAnyway={() => {
            void closeSpace(closeTarget.path).catch((err) => {
              console.error(`failed to close the ${closeTarget.path} tab:`, err);
            });
            setCloseTarget(null);
          }}
          onClose={() => setCloseTarget(null)}
        />
      )}
    </div>
  );
}
