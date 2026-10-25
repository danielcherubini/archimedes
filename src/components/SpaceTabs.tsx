import { useCallback, useMemo, useState } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import { basenameOfPath } from "../lib/paths";
import { titleFor } from "../lib/sessionTitle";
import { useSessions } from "../store/sessions";
import { useSessionStatuses } from "../hooks/useSessionStatus";
import { useDragReorder } from "../hooks/useDragReorder";
import { SessionStatusMark } from "./SessionStatusMark";
import { cn } from "./lib/utils";
import type { SessionStatus } from "../hooks/useSessionStatus";
import CloseSpaceDialog from "./CloseSpaceDialog";
import { openNewSpaceDialog } from "../lib/newSpaceDialogState";
import { Button } from "./ui/button";

/**
 * C7 (finding 6d): what `<Button>`'s base and the `default` size would change on
 * the TAB LABEL, undone. Both axes are named explicitly at the site
 * (`variant="link" size="default"`) because `ui/button.tsx:40` sets
 * `defaultVariants {variant: "default"}` and a bare `<Button>` would paint every
 * tab `bg-primary text-primary-foreground` on a fixed `h-7 px-2` box.
 *
 * Measured with the real `cn()` (the utility SET of the rendered class attribute
 * is exactly what the label spelled — zero lost tokens in both states) and with
 * a headless-browser layout probe against the compiled sheet (box 156×32,
 * `font-size: 14px`, `line-height: 21px`, `flex-shrink: 1`, and the inner
 * `truncate` span eliding, byte-for-byte the same before and after). What each
 * entry removes:
 *  - `border-0`        — the base's `border` is a 1px ring (preflight sets
 *                        `border: 0 solid`, so the label has none today); it
 *                        would inset the label 1px inside the pill and shift the
 *                        `pl-3` text by the same amount. With the width at zero
 *                        the base's `bg-clip-padding` is a no-op besides.
 *  - `h-auto`          — the size's `h-7` is a FIXED 28px. The label is the
 *                        element that `self-stretch`es to own the pill's `h-8`,
 *                        and a fixed height would override that: 28px inside a
 *                        32px pill is exactly the dead-pixel gap the pill's own
 *                        comment records fixing.
 *  - `px-0`            — the size's `px-2` would add 8px the pill does not have
 *                        (`pl-3` is the label's whole leading inset and the ✕'s
 *                        `mr-3` its trailing one). It does NOT touch `pl-3`:
 *                        measured through `cn()`, `px-0` and `pl-3` are BOTH
 *                        kept (`pl-3` is a different tailwind-merge group and
 *                        comes last), and the probe confirms the inset renders.
 *  - `justify-start`   — the base centres on the main axis; the label is a
 *                        left-aligned browser tab.
 *  - `shrink`          — the base's `shrink-0` is `flex-shrink: 0` and the label
 *                        IS a flex item of the pill. The probe caught this one:
 *                        with the base in place the label refused to shrink and
 *                        overflowed the `max-w-48` cap to 447.8px instead of
 *                        eliding at 156px, so long folder names would push the ✕
 *                        out of the pill instead of showing `…`. `shrink` is the
 *                        `flex-shrink: 1` the label has today.
 *  - `whitespace-normal` — the base's `whitespace-nowrap` (the label inherits
 *                        `normal`; the elision lives on the inner `truncate`
 *                        span, which needs the normal wrapping context).
 *  - `select-auto`     — the base's `select-none` would make a Space's name
 *                        unselectable. This one is settled by the MERGE, not by
 *                        the sheet: `mergeUiClasses` treats `select-auto` and
 *                        `select-none` as ONE group and keeps the LAST, i.e. this
 *                        wall's utility, so the base's never reaches the
 *                        attribute. Worth stating precisely because the cascade
 *                        would NOT have rescued it — in the built sheet
 *                        `.select-auto` is emitted BEFORE `.select-none`
 *                        (offsets 45726 / 45781, measured), so had both survived
 *                        into one class list the base would have won. (The
 *                        `[user-select:auto]` form two sibling C7 walls use lands
 *                        at 45906, after both, and wins either way.)
 *  - `transition-none` — the base's `transition-colors` would fade the
 *                        active/inactive ink swap over 150 ms. Selecting a tab
 *                        is instant today, and a fade on the tab you just
 *                        clicked reads as lag.
 *  - `hover:no-underline` — `link`'s `hover:underline` would underline the tab
 *                        name on hover. `link` is the variant because it is the
 *                        only arm with no hover BACKGROUND (the pill owns the
 *                        fill; a `ghost` arm's `hover:bg-hover` would paint a
 *                        second surface inside the pill and could only be
 *                        displaced by re-spelling a `hover:bg-*`). Its
 *                        `text-primary` loses the text-colour group to the
 *                        label's own `text-foreground`/`text-foreground-subtle`,
 *                        and its `underline-offset-4` survives but is inert —
 *                        with no underline there is nothing to offset.
 * NOT in the wall, because the label spells the group and comes LAST, so the
 * label wins it outright (each measured): `flex` over the base's `inline-flex`,
 * `items-center`, `gap-1.5` over `gap-1`, `text-ui-base` over BOTH the size's
 * `text-ui-base` and the base's `text-ui-base/relaxed` (one utility survives, so
 * no `line-height` is declared and the label keeps preflight's 1.5 — and,
 * critically, the label GAINS no second `.text-ui-base` for
 * `ChatStream.test.tsx`'s `primaryLines()` to mistake for a picker row), and
 * `min-w-0`/`self-stretch`/`pl-3`, which the base does not spell at all.
 * Inert additions: `rounded-md` (the label paints no background and no border,
 * so a 6px radius has nothing to clip); `bg-clip-padding` (same reason);
 * `outline-none` (`base.css:53-57` forces `outline: none !important` on every
 * focus, in every browser and again under `forced-colors`); `disabled:*` (a tab
 * is never disabled); `aria-invalid:*` (nothing sets it on a `role="tab"`);
 * `group/button` (nothing reads that group — grep-verified);
 * `has-data-[icon=inline-*]:pr/pl` (lucide sets no `data-icon`);
 * `[&_svg]:pointer-events-none` (the click handler is on the label, and the
 * `SessionStatusMark` glyph is decoration, not a target); `[&_svg]:shrink-0`; and
 * `[&_svg:not([class*='size-'])]:size-3.5` — the icon-resize hazard, checked
 * rather than assumed, and it does NOT reach the 14px slot by a different route
 * for each of the two glyphs the tab can draw: the `running` SPINNER's own class
 * list contains `size-4` (`ui/spinner.tsx`), so the `:not([class*='size-'])`
 * guard excludes it outright, and the `waiting` `?` carries no `size-` class so
 * the rule DOES match it — but `SessionStatusMark` writes its box as an INLINE
 * `style` (`width`/`height` in px, that component's own design), and an inline
 * style outranks a class rule, so the mark stays 14px either way.
 * `data-slot`/`data-variant`/`data-size` are new attributes; no test reads them
 * on this element, and `role="tab"` + `aria-selected` pass through `...rest`.
 */
const TAB_LABEL_WALL =
  "border-0 h-auto px-0 justify-start shrink whitespace-normal select-auto transition-none hover:no-underline";

/**
 * C7: the same undo for the `+` New-Space button (`variant="ghost"
 * size="icon-lg"`), whose own class list is kept VERBATIM and last.
 *  - `border-0` — the base's 1px ring would grow the 32px square to 34px (the
 *                 chrome strip's second cluster is a `size-8` box by decision —
 *                 see the ✕'s comment and `chromeButton.test.ts`).
 *  - `inline-block` — the base's `inline-flex` + `items-center` +
 *                 `justify-center` would CENTRE the `+` glyph. Measured in a
 *                 browser against the compiled sheet: today the glyph sits at
 *                 the box's left edge (16px of bare hover patch to its right)
 *                 and the conversion would slide it 8px right. That is a real
 *                 repaint, so the display is restored here rather than smuggled
 *                 into a refactor commit; the left-edge reading itself is
 *                 reported as a separate finding, not silently "fixed".
 *  - `whitespace-normal` / `select-auto` — the base's `whitespace-nowrap` and
 *                 `select-none` (the button spells neither group).
 *  - `text-[length:inherit]` — `icon-lg` spells no font size, but the BASE does
 *                 (`text-ui-base/relaxed` = 14px + 1.625), and the button today
 *                 inherits 16px. Provably inert for a lone block `<svg>` child,
 *                 restored anyway so the site ends up declaring no font-size at
 *                 all — the same rule C7 group 4 learned from
 *                 `ChatStream.test.tsx`'s `.text-ui-base` picker query.
 *  - `transition-none` — the base's `transition-colors` would fade the hover
 *                 fill in over 150 ms. This cluster's fill is always-on
 *                 (`bg-surface-hover`, no transition) by the ADR 0038 split that
 *                 `chromeButton.test.ts` guards — which is also why the `ghost`
 *                 arm's `hover:bg-hover` is displaced by the site's own
 *                 `hover:bg-surface-hover` (the same group, spelled last).
 *  - `hover:text-foreground-subtle` — `ghost` carries
 *                 `hover:text-foreground`, and this `+` has never brightened its
 *                 glyph on hover (only its fill). Naming the SAME utility the
 *                 site spells at rest is how the hover pair is neutralised
 *                 without touching the variant.
 * Inert here: `size-8` from `icon-lg` is the size the site already spells (one
 * `size-*` survives); its `rounded-lg` LOSES the border-radius group to the
 * site's `rounded-md` (measured: `rounded-md` is the only radius left), which is
 * the `className`-wins-the-group case the brief asked to confirm;
 * `items-center`/`justify-center` have no flex container once `inline-block`
 * wins; `text-foreground` and `aria-expanded:*` (never expanded);
 * `disabled:*`; `outline-none`; `group/button`; `has-data-[icon=inline-*]`;
 * `[&_svg]:pointer-events-none` / `[&_svg]:shrink-0` / and
 * `[&_svg:not([class*='size-'])]:size-4` — the glyph carries an explicit
 * `size-4`, so the `:not([class*='size-'])` guard excludes it (the icon-resize
 * hazard, checked).
 */
const NEW_SPACE_BUTTON_WALL =
  "border-0 inline-block whitespace-normal select-auto transition-none text-[length:inherit] hover:text-foreground-subtle";

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
function tabStatusOf(
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
 * THE STRIP IS DRAG-REORDERABLE (ADR 0075). It renders the store's `spaces`
 * array verbatim — that array IS the Manual order — and a drag writes through
 * the store's optimistic `reorderSpaces`, exactly as the sidebar's rows write
 * through `reorderSessions`. ONE `useDragReorder` instance covers the whole
 * strip: the gesture, the pointer's half and the indicator state are the hook's
 * answers, and nothing in this file computes an index or sorts. Because
 * `SpacesList`'s `views` is `spaces.map(spaceViewFor)`, the tab strip and the
 * sidebar's group order inherit the same array and cannot disagree. HTML5 DnD is
 * POINTER-ONLY, so a keyboard user cannot reorder — an accepted gap (ADR 0075),
 * recorded rather than left implicit.
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
 * the bar it sits in is a drag region, and a control must never be chrome — and
 * since ADR 0075 the same attribute is the SECOND reason it must stay, because
 * it is what stops Tauri's injected script claiming the mousedown that starts a
 * tab DRAG. The pill is the drag surface; the ✕ opts back out.
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

  // THE DRAG, over the strip's own order. `spaces` IS the Manual order (ADR
  // 0075: `Db::list_spaces` returns `sort_order`, the store never re-sorts, and
  // `SpacesList`'s `views` is `spaces.map(spaceViewFor)`), so the ids handed to
  // the hook are the same sequence the strip renders and the sidebar groups by —
  // one source, and nothing here sorts. The `useMemo` keeps the array's identity
  // stable across renders that did not change the strip, because `useDragReorder`
  // closes its handlers over `ids` and rebuilds them whenever it changes.
  const spacePaths = useMemo(() => spaces.map((s) => s.path), [spaces]);
  // The write is the store's optimistic `reorderSpaces`, whose rollback restores
  // the array it captured before the write (ADR 0075's Write path, as amended
  // during T05: a refetch would be a WIDER mutation than the one being undone).
  // It gets the WHOLE strip in its new order, not the moved tab — the command
  // writes each slice index as the Space's stored number, so a partial list is a
  // half-moved list, and a tab the slice omits is kept at the BOTTOM.
  const reorderSpaces = useSessions((s) => s.reorderSpaces);
  const handleReorder = useCallback(
    (paths: string[]) => void reorderSpaces(paths),
    [reorderSpaces],
  );
  const drag = useDragReorder({
    ids: spacePaths,
    onReorder: handleReorder,
    // THE STRIP IS HORIZONTAL, so the pointer's half is read off X. This one
    // argument is the whole difference between this call site and the sidebar's:
    // a tab drag holds `clientY` constant, so with the default `"y"` the landing
    // side was decided by where in the pill the user grabbed — and a grab at the
    // pill's vertical centre answered "after" for every target, which turns every
    // RIGHTWARD tab drag into the order the strip already had and therefore a
    // SILENT NO-OP (the hook's "nothing moved" guard fires and no write happens).
    // Leftward drags landed on "after" too, and so looked fine.
    axis: "x",
  });

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
    //
    // THE TABLIST (finding 18). Marked on THIS existing container — the element
    // that already carries `data-testid="space-tabs"` — because it *is* the tab
    // strip. Deliberately NOT a new wrapper around `spaces.map()`: the pill
    // inside that block holds both the `role="tab"` label and the ✕, so a fresh
    // `role="tablist"` level would own generic `div` children plus two buttons
    // (`SpaceTabs.test.tsx` pins `close.parentElement === tab.parentElement`),
    // i.e. a worse ARIA tree than the one it replaced. Two attributes, no new DOM
    // level.
    //
    // ACCEPTED ARIA LIMITATION — record, do NOT "fix". The per-tab ✕ and the
    // `New space` button stay SIBLINGS of the tabs inside this tablist, and the
    // pill `div`s are generic children of it. The ARIA tabs pattern has no owned
    // slot for a per-tab close button: a `tab` may not hold an interactive child
    // (it is dropped from the accessibility tree and `<button>`'s content model
    // forbids it — see the note at the top of this file), so there is nowhere
    // legal to put the ✕ *inside* its tab. This UI is deliberately browser-style
    // closable tabs, and every browser-tab UI makes the same trade. A tablist
    // with sibling controls is strictly better than orphaned `role="tab"`s with
    // no tablist parent. So this is NOT to be revisited by restructuring the pill,
    // wrapping children in `role="presentation"`, or adopting Radix Tabs —
    // `ui/tabs.tsx`'s segmented-control geometry is wrong for this strip and it
    // has no place for the ✕ or the `+` either.
    <div
      role="tablist"
      aria-orientation="horizontal"
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
            //
            // THE SECOND REASON, and the one that made this attribute
            // load-bearing twice (ADR 0075): the pill is now a DRAG SOURCE, and
            // an HTML5 drag begins from the very mousedown that script hunts for.
            // Without `"false"` the script claims it as a WINDOW drag, the
            // browser never starts the tab's drag, and the strip looks draggable
            // while moving the window. jsdom has no injected script, so no test
            // here can catch its removal — which is exactly why the attribute is
            // pinned twice in `SpaceTabs.test.tsx` (its presence, and its
            // survival of a reorder re-render) rather than trusted.
            className={cn(
              // `bg-surface hover:bg-surface-hover` and `bg-surface-hover` are
              // mutually exclusive arms of one background group, so the merge is
              // the identity. `SpaceTabs.test.tsx:350` pins
              // `inactive.className === active.className` for the ✕ (a different
              // element, untouched here) and `SpaceTabs.pill.test.tsx` reduces
              // class lists to geometry — a merge that only drops a losing arm
              // cannot move either.
              "flex h-8 max-w-48 items-center rounded-md",
              active ? "bg-surface-hover" : "bg-surface hover:bg-surface-hover",
              // THE DROP INDICATOR — one edge, one class, on the pill that is
              // already there (spec §Indicator). `border-brand` is named rather
              // than left to `currentColor`, which would paint the line in
              // whatever ink the tab's own text wears; it is the same token the
              // sidebar row marks its edge with, so an edge means one thing in
              // both lists. The two edge utilities are mutually exclusive, and
              // `preflight`'s `box-sizing: border-box` means the 2px insets the
              // label rather than growing the `h-8` pill.
              //
              // LEFT AND RIGHT, because this strip is horizontal. The hook's
              // `DropEdge` means EARLIER/LATER in the array — axis-neutral — and
              // the CALL SITE chooses the physical border that means "earlier" in
              // its own layout: here "before" is the pill's LEFT edge and "after"
              // its RIGHT one. The sidebar, a vertical list, keeps top/bottom.
              // That choice lives here and not in the hook precisely so the hook
              // keeps one copy of the ordering arithmetic and zero opinions about
              // markup.
              //
              // The target test is `drag.overId === s.path`, NOT `overEdge`
              // alone — the hook keeps the two as separate answers precisely so
              // a call site cannot paint the current edge on every tab.
              drag.overId === s.path && drag.overEdge === "before" && "border-l-2 border-brand",
              drag.overId === s.path && drag.overEdge === "after" && "border-r-2 border-brand",
            )}
            // THE DRAG SURFACE (ADR 0075, spec §Handle: "the whole row / pill is
            // draggable"). The hook's six keys — `draggable: true` plus the five
            // handlers — land on the WRAPPER rather than on the label, because
            // the wrapper is the pill: it owns the geometry, the fill, and the
            // pixels the label does not cover, so a drag started anywhere in the
            // tab (including its dead pixels — see the `self-stretch` note) is a
            // drag of the tab. The `✕` opts back out below.
            {...drag.dragProps(s.path)}
            data-tauri-drag-region="false"
            onMouseDown={(e) => {
              // Middle-click anywhere on the pill closes the tab, as in every
              // browser. `button: 1` only — a left press belongs to whichever
              // control sits under it, and the right button belongs to the OS.
              // (The drag script never claims button 1, so this still fires
              // over the pill's `"false"` drag region, which only answers to
              // the left button.)
              //
              // THE EARLY RETURN IS ALSO WHAT KEEPS A DRAG FROM CLOSING THE TAB
              // (ADR 0075): the left button is the button a drag starts with, so
              // once the pill became a drag source this `!== 1` guard became the
              // second half of "pressing to drag does not close the tab". It is
              // pinned by `SpaceTabs.test.tsx`'s "a LEFT-drag started on the tab
              // pill does not close the tab", which completes a real gesture and
              // then asserts the middle-click still closes — both halves of this
              // one handler.
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
            <Button
              type="button"
              role="tab"
              aria-selected={active}
              variant="link"
              size="default"
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
              className={cn(
                TAB_LABEL_WALL,
                "flex min-w-0 self-stretch items-center gap-1.5 pl-3 text-ui-base",
                active ? "font-medium text-foreground" : "text-foreground-subtle",
              )}
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
            </Button>
            <button
              type="button"
              aria-label={`Close ${name}`}
              title="Close tab"
              // `draggable={false}`: the pill is a drag source and this ✕ is its
              // CHILD. `draggable` is not an inherited property, but the browser
              // resolves a drag on a nested element by walking to the nearest
              // draggable ANCESTOR — so with nothing said here, a press on the
              // close control starts a drag of the TAB instead of closing it
              // (spec §Handle + §5 #18 — the same opt-out T06 gave the sidebar's
              // Stop / Archive / Delete). Pinned in `SpaceTabs.test.tsx`
              // alongside the pill's own `draggable="true"`, so the assertion
              // cannot be satisfied by a pill that stopped being draggable.
              draggable={false}
              onClick={() => requestClose(s.path, name)}
              // NOT `CHROME_BUTTON` (the chrome bar's shared button grammar,
              // `./chromeButton.ts`) and NOT a shared component — deliberately.
              // This ✕ and the `+` below are the SECOND chrome cluster, and per
              // CONTEXT.md **Chrome controls** + ADR 0038 the two clusters differ
              // ON PURPOSE: this is a 20px (`size-5`) square with `rounded` and an
              // ALWAYS-ON `bg-surface-hover` fill, not the chrome bar's 28px
              // (`h-7 w-7`) `rounded-md` button that fills `bg-hover` and
              // colour-TRANSITIONS in (`transition-colors`). It also sits inside
              // the drag region and inside the pill, so it is inset by `ml-1 mr-3`
              // to match the label's own inset. Folding these two onto that
              // constant would repaint the strip and pull the tab controls into
              // the grammar ADR 0038 scopes to the top-right cluster — and
              // `chromeButton.test.ts` reddens the import that would do it.
              // ALWAYS there — on the active tab and on every other one. The
              // first version drew it TRANSPARENT until the pointer reached the
              // pill, which made an un-hovered tab look un-closable (and left a
              // focusable control that could not be seen). It costs its 24px of
              // the `max-w-48` cap either way, so nothing is saved by hiding it.
              // `grid place-items-center` centres the glyph in the 20px square,
              // and the pill centres the square — no self-centring to get wrong.
              // `focus-visible:` mirrors the hover fill, so tabbing to the ✕
              // shows the same patch the pointer gets.
              //
              // STILL A RAW `<button>` AFTER C7, and that is a measured blocker
              // rather than an omission: `Button`'s base carries
              // `disabled:opacity-50`, and `SpaceTabs.test.tsx` ("the ✕ sits on
              // EVERY tab") asserts this element's class matches no
              // `/opacity-/` at all. `tailwind-merge` can only drop a utility a
              // LATER class in the same group names, and this class list spells
              // no `opacity-*`, so the variant survives any `className` we could
              // pass. PROVEN, not argued: converting this one site to
              // `variant="ghost" size="icon-xs"` in a scratch tree reddened
              // exactly that assertion (1 failed / 33 passed) with
              // `disabled:opacity-50` still in the rendered class list. Removing
              // the base's `disabled:` pair is a change to the shared primitive
              // AND to that test's contract — both out of scope for a sweep whose
              // rule is that no assertion moves.
              className="ml-1 mr-3 grid size-5 shrink-0 place-items-center rounded text-foreground-subtle hover:bg-surface-hover focus-visible:bg-surface-hover hover:text-foreground focus-visible:text-foreground"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        );
      })}
      <Button
        type="button"
        aria-label="New space"
        variant="ghost"
        size="icon-lg"
        onClick={openNewSpaceDialog}
        // The `+` is the other half of the SECOND chrome cluster — see the
        // ✕'s comment above for why this is not `CHROME_BUTTON` (`size-8`,
        // `bg-surface-hover`, no `transition-colors`). C7 routes it through
        // `Button` with both axes named; `NEW_SPACE_BUTTON_WALL` undoes the base
        // utilities that would move the glyph or the box (in particular
        // `inline-block`, which keeps the `+` where it sits today instead of
        // centring it), and the site's own class list comes LAST so it wins
        // every group it spells — including `rounded-md` over `icon-lg`'s
        // `rounded-lg`.
        className={cn(
          NEW_SPACE_BUTTON_WALL,
          "size-8 shrink-0 rounded-md text-foreground-subtle hover:bg-surface-hover",
        )}
      >
        <PlusIcon className="size-4" />
      </Button>
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
