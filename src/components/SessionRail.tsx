import { SessionStatusMark } from "./SessionStatusMark";
import { Button } from "./ui/button";
import { cn } from "./lib/utils";
import type { SessionStatus } from "../hooks/useSessionStatus";

/** One command, offered as an icon button at the head of the rail. */
export interface SessionRailAction {
  id: string;
  /** The accessible name AND the hover text (the rail has no room for a label). */
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}

export interface SessionRailRow {
  /** The session id — the list key, and the handle the statuses are keyed by. */
  key: string;
  status: SessionStatus;
  active: boolean;
}

/**
 * The sidebar's session list reduced to marks, for the collapsed left RAIL
 * (the 40px sliver): the shape of the list at a glance — how many sessions,
 * which one is active, and above all WHICH ONES ARE WORKING OR WAITING — with
 * no text and no scrolling.
 *
 * WHAT IT MIRRORS: the OPEN sidebar lists the ACTIVE space's sessions (live
 * first, then stored), so that is what the rail maps, in the same order — the
 * Nth mark is the Nth row, and that positional identity is the only reason the
 * column of dots means anything. (The Space itself needs no mark: it is the
 * active TAB, lit in the tab strip directly above the rail. Archived sessions
 * are a collapsed section in the list, and stay out of the rail.)
 *
 * THE STATES COME FROM `useSessionStatus` — the SAME hook the open rows use —
 * so the rail and the list cannot disagree about what "running" means, and the
 * GLYPHS come from `SessionStatusMark` for the same reason: the rail is the
 * open row's own mark set at 10px, not a second visual language. Spinner =
 * live + in a turn; `?` = a pending permission / ask / password (the app's
 * attention ink, the one the toggle dots carry); filled ring = live and idle;
 * dim ring = stored. Waiting outranks running: a blocked session is not
 * working, it is waiting on YOU. The active session's mark takes the brighter
 * ink — the open row marks it with a `bg-selected` FILL, which a 10px mark has
 * no room for, so it is weight, not a rail-only colour.
 *
 * THE ACTIONS RIDE ALONG, and that is a deliberate reversal of the rail's
 * "readout only" rule. A collapsed sidebar must not cost you the pane's
 * commands: the buttons are inside the content region (so they are `invisible`
 * here), and `Skills` has NO keyboard shortcut, so without this strip
 * collapsing the sidebar would hide the command rather than merely narrow it.
 * The icon strip is the same principle the sliver already follows: a collapsed
 * pane keeps its controls, it does not hand them to another surface and make
 * them teleport.
 *
 * THE THREE ARE THE LIST'S OWN BUTTONS (Open Space, New Session, Skills), so
 * they sit ABOVE the marks at a fixed offset and the marks keep their
 * positional contract (the Nth mark is the Nth row). `Settings` is NOT one of
 * them: the gear lives in the chrome bar's `ChromeControls` in both states, so
 * the rail used to carry a second copy of it at its bottom, and that tail strip
 * is gone.
 *
 * The blocks also have OPPOSITE pointer rules in the same 40px column — the
 * marks are `pointer-events-none` (a readout must not steal a click), the
 * command strip must be clickable — so `pointer-events-none` is set per block,
 * never on the frame. And `flex-1` belongs to the MARKS alone, which is what
 * lets a long list clip instead of pushing the frame taller.
 *
 * THE GEOMETRY IS THE `TodoRail` GRAMMAR, unchanged: rows are
 * `flex-1 min-h-5 max-h-10` in a top-anchored column (short lists cluster at
 * the top and read as a list, long lists floor at 20px and CLIP their tail —
 * never scroll), inside a marks area that is `flex-1 min-h-0` so it takes
 * exactly the height the action strip leaves.
 * See `TodoRail`'s doc for why clipping is directional and why no
 * `ResizeObserver` is involved.
 */

/** The mark box (a hair under the open row's 16px status slot). */
const MARK_PX = 10;

/**
 * One session's mark. The GLYPH is `SessionStatusMark`'s — the same component
 * the open row and the tab draw — so the rail cannot drift from the list it
 * summarises; this file owns only the SIZE and the fact that a mark is a mark.
 * NO `title` anywhere in the rail: the strip is `pointer-events-none`, so a
 * tooltip could never appear, and `role="img"` on the marks container makes the
 * marks decoration to AT — the summary carries the count.
 */
function SessionMark({
  status,
  active,
}: {
  status: SessionStatus;
  active: boolean;
}) {
  return (
    <SessionStatusMark
      status={status}
      active={active}
      size={MARK_PX}
      testId="session-mark"
      // Silent by design, and stated rather than inherited: the marks sit
      // inside a `role="img"` container whose label is the whole summary
      // ("Sessions 3, 1 running, 1 waiting"), and children of `role="img"` are
      // presentational per ARIA. An `aria-label` on a mark would then be dead
      // weight at best and a doubled announcement on an AT that does not prune
      // at worst — so the marks ask for presentation explicitly and the summary
      // alone carries the counts.
      announce={false}
    />
  );
}

export default function SessionRail({
  rows,
  actions = [],
}: {
  rows: SessionRailRow[];
  /** Commands at the HEAD of the rail (the pane's top-of-list buttons). */
  actions?: SessionRailAction[];
}) {
  if (rows.length === 0 && actions.length === 0) return null;
  const running = rows.filter((r) => r.status === "running").length;
  const waiting = rows.filter((r) => r.status === "waiting").length;
  // The accessible name is the COUNTS — the marks carry no text, and the list
  // behind them is `invisible` while collapsed, so the summary is in the a11y
  // tree exactly once. Zero counts drop out: a plain list reads as a plain
  // list. (Titles are deliberately absent — the rail is positional, and the
  // names live in the tabs and the transcript.)
  const label = [
    `Sessions ${rows.length}`,
    running > 0 && `${running} running`,
    waiting > 0 && `${waiting} waiting`,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    // The FRAME is positioned only — no `pointer-events-none` here, or the
    // action buttons below would be click-through. `bottom-2` is ordinary
    // padding: the rail used to stop at `bottom-9` to clear the pane's own
    // collapse toggle in the footer, and that toggle now lives in the chrome
    // bar, so the sliver's whole height is the rail's again.
    // NO folder/heading mark: the rail starts directly under the active TAB
    // (the tab strip's `pl-1` lines it up with this column), so the space it
    // belongs to is already lit one row above — herdr numbers its rail because
    // its rail IS the workspace list, while here the tabs are that list.
    <div
      data-testid="session-rail"
      className="absolute inset-x-0 top-2 bottom-2 flex flex-col gap-1 overflow-hidden"
    >
      {/* The rail's command strip, at the HEAD (above the marks, so the marks
          keep their positional contract). One column of icon buttons — the
          open pane's own buttons at the same `size-6`, since a collapsed pane
          keeps its commands rather than handing them to another surface. */}
      {actions.length > 0 && (
        <div
          data-testid="session-rail-actions"
          className="flex shrink-0 flex-col items-center gap-1"
        >
          {actions.map((a) => (
            <Button
              key={a.id}
              type="button"
              variant="ghost"
              size="icon-sm"
              // `aria-label` AND `title`: the rail has no room for a label, so
              // the hover text is the only thing naming the icon.
              aria-label={a.label}
              title={a.label}
              onClick={a.onClick}
              className={cn(
                // C7: the two utilities that UNDO `Button`'s base, both of
                // which would change what this 24px icon button paints. They
                // come BEFORE the row's own classes so the row wins every group
                // it spells; these two are groups it does not spell at all.
                //   `border-0`        — the base's `border` is a 1px ring that
                //                       would grow the 24px box to 26px (the
                //                       base's `border-transparent` alone keeps
                //                       the width, `border-0` removes it);
                //   `transition-none` — the base's `transition-colors` adds a
                //                       150 ms hover fade this strip never had.
                //                       `chromeButton.ts` WANTS that fade; the
                //                       rail does not, and it stays as drawn.
                // Everything else the base adds is inert HERE:
                //   `bg-clip-padding` — no background to clip;
                //   `outline-none`    — `base.css:53-57` already kills every
                //                       outline and focus ring with `!important`
                //                       in every browser and in forced-colors;
                //   `disabled:*`      — this control is never disabled;
                //   `aria-invalid:*`  — nothing ever sets `aria-invalid` here;
                //   `group/button`    — nothing in the tree reads that group;
                //   `text-ui-base/relaxed` — this IS a change to the declared
                //                       value, and it is inert only because the
                //                       button has no text at all: its one
                //                       child is an `<svg class="size-4">`, and
                //                       `size-4` is `calc(var(--spacing) * 4)`
                //                       — rem, not em — so neither the
                //                       font-size nor the line-height can reach
                //                       it. Before, the button inherited the UA
                //                       16px (the app never sets a root
                //                       `font-size`; it sizes text only through
                //                       `--ui-font-size` and the `text-ui-*`
                //                       utilities). After, it declares 14px.
                //                       A box that is `size-6` with
                //                       `items-center` and one fixed-size icon
                //                       renders the same either way. Same for
                //                       `whitespace-nowrap` and `select-none`:
                //                       there is no text to wrap or select.
                //   `whitespace-nowrap` — the content is one icon, no text;
                //   `select-none`     — there is no text to select;
                //   `has-data-[icon=…]:pr/pl` — no child carries `data-icon`
                //                       (lucide icons set no such attribute);
                //   `[&_svg]:pointer-events-none` — the click lands on the
                //                       button either way (the handler is on
                //                       the button and jsdom dispatches there);
                //   `[&_svg]:shrink-0` — the glyph is a fixed `size-4`;
                //   `[&_svg:not([class*='size-'])]:size-3` — every `a.icon` is
                //                       built with an explicit `size-4` in
                //                       `SpacesList`'s `railActions`, so the
                //                       `:not([class*=size-])` guard excludes
                //                       all of them.
                "border-0 transition-none",
                "flex size-6 shrink-0 items-center justify-center rounded-md text-foreground-subtlest hover:bg-surface-hover hover:text-foreground-subtle",
              )}
            >
              {a.icon}
            </Button>
          ))}
        </div>
      )}
      {/* The marks, and ONLY when there are sessions: an empty `role="img"`
          reading "Sessions 0" is noise, and the command strip is exactly what
          a user with an empty space needs. `flex-1 min-h-0`: the area takes exactly the height the
          action strip leaves, and `min-h-0` is what LETS it shrink — a flex
          child's automatic minimum is its content's height, so without it a
          30-session list would push the frame taller instead of clipping.
          `role="img"` + the count lives HERE, not on the frame: the actions are
          real buttons in the a11y tree, and an `img` ancestor would hide them. */}
      {rows.length > 0 && (
        <div
          data-testid="session-rail-marks"
          role="img"
          aria-label={label}
          className="pointer-events-none flex min-h-0 flex-1 flex-col justify-start gap-1 overflow-hidden"
        >
          {rows.map((row) => (
            <div
              key={row.key}
              data-testid="session-row"
              className="flex max-h-10 min-h-5 w-full flex-1 items-center justify-center"
            >
              {/* Explicit props, NOT `{...row}`: React 19 warns when a spread
                  object contains `key`, and the rail re-renders on every
                  streamed chunk, so it would spam the dev console. */}
              <SessionMark status={row.status} active={row.active} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
