import { CircleQuestionMarkIcon } from "lucide-react";
import { Spinner } from "./ui/spinner";
import type { SessionStatus } from "../hooks/useSessionStatus";

/**
 * The ONE session-state glyph: spinner = working, `?` = blocked on the user,
 * filled ring = live and idle, dim ring = stored.
 *
 * WHY IT IS ONE COMPONENT. Three surfaces show a session's state — the open
 * sidebar row's leading slot, the collapsed rail's column of marks, the tab in
 * the chrome bar — and each used to own its own rendering. Two consequences the
 * user noticed as bugs:
 *
 * - the open row said "waiting" with a TEXT PILL in its TRAILING slot while the
 *   rail said it with a DOT in the LEADING one: one fact, two shapes, two
 *   places to look, and the pill's cost was the row's relative time (while a
 *   session waited you could not see how long ago it had been active);
 * - the rail's IDLE dot had no counterpart in the open row, whose leading slot
 *   was empty unless the session was in a turn — so COLLAPSING the sidebar added
 *   a state the expanded sidebar could not show at all.
 *
 * One glyph set, drawn by one function, at a size the caller picks: the four
 * states are then the same four facts in all three places, and a fifth state
 * means editing one `switch`.
 *
 * THE `?` AND ITS INK. `waiting` — a pending permission, `ask`, sudo password,
 * or a child Session holding one of those — is a question in the literal sense:
 * the Session has stopped and is asking you something. So the glyph is the app's
 * question icon rather than a dot, and it keeps the attention INK
 * (`text-warning`, the token the collapsed pane's toggle dot, the todo board's
 * in-progress `◉` and `SubagentStatusIcon`'s running mark also wear) that made
 * the old dot outrank the spinner. That ink is load-bearing: it is what still
 * reads "blocked on you" once the fill is gone, and `waiting` outranks `running`
 * because a Session parked on a human is not working.
 *
 * IDLE IS A GLYPH NOW, IN BOTH SIDEBAR STATES. `live` and `stored` differ by TWO
 * steps, not one — a thicker ring plus the brighter ink against a hairline ring
 * plus the quietest ink — because at rail size (10px) a single 1px difference is
 * not a visible difference.
 *
 * THE ACTIVE SESSION takes the brighter ink rather than a background fill: the
 * open row marks the active row with a `bg-selected` FILL behind the whole row,
 * and a glyph this small has no room for a fill of its own — so it is weight, not
 * a surface, and both values are existing tokens rather than a mark-only colour.
 *
 * `size` is a px NUMBER, not a Tailwind class: it is written as an inline style,
 * which is what lets ONE value land on the spinner (whose own `size-4` class it
 * outranks) and on the ring/dot alike. A column of marks that changed size as a
 * session changed state would read as jitter, and `style` is the only place the
 * caller can override a class the child hard-codes.
 */
/** The `?`'s RENDERED stroke, in device px, held constant across sizes. */
const QUESTION_RENDERED_STROKE_PX = 1.25;

/**
 * The `?` glyph's `stroke-width` for a given box, so the mark reads as a
 * question mark in the RAIL as well as in the open row.
 *
 * Lucide draws on a 24-unit viewBox with `stroke-width: 2`, and sizing the icon
 * by width/height scales the stroke with it — so the rail's 10px mark would
 * render 2 × 10/24 ≈ 0.83px, a hairline, where the 10px FILLED DOT it replaced
 * was never one. The rail is the worst place to lose it: the list behind it is
 * hidden, so the column of marks is the only readout there is. Hence a constant
 * rendered weight, which makes the attribute HEAVIER for a smaller box.
 *
 * At the row's 16px this yields 1.875 — within a whisker of lucide's default 2,
 * so the row's glyph does not suddenly read bolder than the icons beside it.
 */
function questionStrokeWidth(size: number): number {
  return (QUESTION_RENDERED_STROKE_PX * 24) / size;
}

export function SessionStatusMark({
  status,
  active = false,
  size = 16,
  dotSize,
  testId,
  className = "",
  announce = true,
}: {
  status: SessionStatus;
  /** The session this mark's row/tab is about → the brighter ink (see the doc). */
  active?: boolean;
  /** The glyph's box in px: 16 in the open row (its slot's old `size-4`), 14 in
   * the tab, 10 in the collapsed rail. Applies to the spinner and the `?` —
   * both are OUTLINES, whose weight is what makes them readable. */
  size?: number;
  /** The RING's box when it should differ from `size`; defaults to `size`.
   *
   * The row passes 8 into its 16px slot. The spinner, the `?` and the ring are
   * three different AMOUNTS OF INK, and the ring is the only one that reads as
   * a solid chunk of paint, so at a shared 16px the idle state outshout the
   * working state beside it — which inverts their importance. Halving only the
   * ring fixes the hierarchy without shrinking the two glyphs that carry the
   * states worth shouting about. `size` still sizes them, and the slot stays
   * 16px, so the title's indent and the alignment with the archived rows'
   * `size-4` placeholder are untouched. */
  dotSize?: number;
  /** The hook a placing surface's tests query, when it needs one (the rail and
   * the tab name their own marks; the row queries the STATE instead). */
  testId?: string;
  /** Extra classes from the placing surface — geometry only (e.g. `shrink-0`).
   * NOT ink: the mark owns the ink, and two same-specificity utility classes in
   * one list resolve by CSS source order, which this component cannot control. */
  className?: string;
  /**
   * `false` = decoration, for a surface that already names the state another
   * way. The TAB passes it: its `title` carries "waiting for you" / "working",
   * and a name inside the tab button folds into the tab's ACCESSIBLE NAME
   * ("beta Waiting for you") — renaming a control under the user mid-
   * conversation. It is also the rule the tab's own spinner followed
   * (`aria-hidden`). The sidebar ROW keeps the default: its text "Waiting" pill
   * is gone, so the glyph is the only thing that says it.
   */
  announce?: boolean;
}) {
  const ink = active ? "text-foreground" : "text-foreground-subtlest";
  const box = { width: size, height: size };
  // The ring halves (`dotSize`) while the spinner and the `?` keep the full
  // slot — see the prop's doc. Read only by the ring branch below (the spinner
  // and the `?` return before it), so a caller passing `dotSize` for a running
  // or waiting session changes nothing.
  const dotPx = dotSize ?? size;
  // A ring SMALLER than its slot still has to OCCUPY the slot, and that is the
  // only case that costs a wrapper node. Everywhere the two agree — the rail,
  // the tab — the glyph IS the box, one node, exactly as before.
  const slotNeeded = dotPx !== size;
  // What the glyph contributes to the accessibility tree. Announced: the `?`
  // names itself (below) and the spinner keeps the `role="status"` `Spinner`
  // gives it. Decoration: BOTH are hidden, so a mark can never rename the
  // control it sits inside. One object, spread by every branch, so the two
  // modes cannot drift apart per branch.
  const a11y = announce
    ? // `role="img"` + a label: the open row used to carry the word "Waiting"
      // as TEXT and that text is gone, so in the row the glyph IS the
      // statement. (`aria-hidden` here would silently make the state invisible
      // to a screen reader.)
      { role: "img" as const, "aria-label": "Waiting for you" }
    : { role: "presentation" as const, "aria-hidden": true };

  if (status === "running") {
    return (
      <Spinner
        {...(testId ? { "data-testid": testId } : {})}
        // In the ANNOUNCED mode the spinner is left exactly as `Spinner` renders
        // it — `role="status"` + its own "Loading…" label — because that is the
        // behaviour both the row and the rail had before this component existed,
        // and the rail silences it anyway (its marks container is one
        // `role="img"` summary, which makes these decoration). Re-labelling it
        // "Working" from here would rename a glyph every `Spinner` in the app
        // uses; that is `Spinner`'s call, not this one's.
        {...(announce ? {} : a11y)}
        style={box}
        className={`animate-spin ${ink} ${className}`}
      />
    );
  }

  if (status === "waiting") {
    return (
      <CircleQuestionMarkIcon
        {...(testId ? { "data-testid": testId } : {})}
        {...a11y}
        style={box}
        // See `questionStrokeWidth`: at rail size the icon's own `stroke-width`
        // of 2 would render under a pixel, and the rail is the one surface with
        // no list behind it to fall back on.
        strokeWidth={questionStrokeWidth(size)}
        className={`shrink-0 text-warning ${className}`}
        data-dot="waiting"
      />
    );
  }

  const dot = status === "live" ? `border-2 ${ink}` : `border ${ink}`;
  const testProps = testId ? { "data-testid": testId } : {};
  // The ring, built ONCE. `data-dot` and `aria-hidden` live on the glyph
  // itself — a ring is the least of the three states, the row's title already
  // names the session, and hiding it keeps two rings per row out of the screen
  // reader's reading order (the rail's marks container is one `role="img"`
  // summary and hides these for the same reason).
  const ring = (
    <span
      {...(slotNeeded ? {} : testProps)}
      data-dot={status}
      aria-hidden
      style={{ width: dotPx, height: dotPx }}
      className={`shrink-0 rounded-full ${dot} ${slotNeeded ? "" : className}`}
    />
  );

  if (!slotNeeded) return ring;

  // The rail and the tab get the glyph alone (one node, glyph == box, exactly
  // as before). Only the row takes this branch: the SLOT keeps `size` while the
  // ring inside keeps `dotSize`, because the row's leading slot is shared
  // geometry — the archived rows reserve a `size-4` placeholder there purely so
  // their titles start at the same x, so shrinking the box would slide every
  // title left out of alignment with the Archived section. Centred, so the
  // smaller ring still sits on the same vertical as the spinner's and the `?`'s
  // column in the rows above and below.
  return (
    <span
      {...testProps}
      style={box}
      className={`flex shrink-0 items-center justify-center ${className}`}
    >
      {ring}
    </span>
  );
}
