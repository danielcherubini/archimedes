/**
 * The ONE source of the geometry the child-gate overlay shares with the
 * Subagent transcript SHEET — see `SubagentModals` (the overlay's card panel)
 * and `SubagentDetailHost` (the sheet). Both import from here, so the sheet's
 * width and the panel's dodge offset cannot be two different numbers.
 *
 * WHY THE CLASSES THEMSELVES LIVE HERE. Tailwind reads the SOURCE TEXT, so a
 * class has to appear as a literal somewhere it scans; an interpolated
 * `` `w-[${SUBAGENT_SHEET_WIDTH}px]` `` is invisible to it and compiles to
 * nothing. That is not a reason to keep literals in the components — it is a
 * reason to put them where they can be seen ONCE. Tailwind v4's automatic source
 * detection scans `.ts` modules as well as `.tsx`, so these literals are the
 * compiled set, and the components interpolate THESE constants into their
 * `className` expressions (which is why no component file may carry its own
 * bracketed width literal — `subagentSheetLayout.test.ts` pins that).
 *
 * WHY THE LITERALS ARE ALSO TYPE-ANNOTATED. Each class constant's declared type
 * is a template literal type built from the numeric constant below it, so the
 * scanner-visible literal and the arithmetic are ONE measurement at compile time:
 * change `SUBAGENT_SHEET_WIDTH` and leave the class alone and `tsc` — which
 * `pnpm build` runs — fails on the assignment instead of shipping a sheet the
 * panel no longer clears. `SubagentModals.test.tsx` keeps pinning the pair from
 * the rendered class list too: belt-and-braces, because that is the version a
 * reader can check against a browser.
 *
 * Prose in this repo therefore describes these utilities in words ("the sheet's
 * fixed-width utility"), never by re-typing the bracketed class: Tailwind scans
 * COMMENTS too, so a quoted class in a comment compiles to a rule nothing uses.
 */

/**
 * The Subagent transcript sheet's fixed width (`SubagentDetailHost` pins it to
 * the viewport's right edge at this width, capped at 90% of the viewport), and
 * therefore the offset the gate panel has to clear to sit to the LEFT of it.
 *
 * The sheet caps itself at 90% of the viewport width, so it is only this wide
 * while the viewport is ≥ 480 / 0.9 = 533px; below that the sheet shrinks with
 * the window. The dodge is gated at a breakpoint ABOVE that
 * (`GATE_PANEL_DODGE_BREAKPOINT`), so whenever the offset is applied the sheet
 * really is exactly this wide and the panel lands flush against its left edge.
 */
export const SUBAGENT_SHEET_WIDTH = 480;

/**
 * The narrowest card panel worth dodging for. Below this the panel is not a
 * panel — an `AskQuestionCard` (question text + option buttons) or a
 * `PermissionPrompt` (tool title + option buttons) has nothing left to lay out
 * with, and the user cannot read what they are being asked. 280px is this app's
 * own floor for a card column: the `SidePane` clamps its user-dragged width to
 * 240–480px (its `MIN_WIDTH` / `MAX_WIDTH` pair, applied by `clampWidth`) and
 * the gate panel adds `p-3` (12px per side) around its cards, so 240 + 24 = 264
 * rounds up to the 280 used here.
 */
export const GATE_PANEL_MIN_WIDTH = 280;

/**
 * The viewport width from which the gate panel is allowed to dodge the sheet:
 * the sheet's full width PLUS the narrowest panel worth squeezing into what is
 * left (`SUBAGENT_SHEET_WIDTH + GATE_PANEL_MIN_WIDTH` = 480 + 280 = 760).
 *
 * The window's default is 800px (`src-tauri/tauri.conf.json`: `width: 800`),
 * and nothing bounds how far it can shrink — the window config sets no
 * `minWidth`/`minHeight` and no Rust code calls `set_min_inner_size` — so every
 * narrower width below is reachable by dragging the window. Measured against the
 * dodge's own arithmetic (offset 480px from the right edge, width capped at the
 * viewport minus that offset, so the panel gets `min(480, 100vw - 480)`): 320px
 * of panel at 800, 120px at 600, a ~40px sliver at 520, and at ≤ 480 the cap
 * clamps to 0 while the 480px offset pushes the box off-viewport — a gate that is
 * MOUNTED AND UNREACHABLE, which strands the child just as surely as a gate
 * that was never rendered (and since ADR 0055, forever: a gate-parked child is
 * an Active Subagent, so no clock ends the delegation). Below this
 * breakpoint the panel therefore keeps its corner geometry (right edge, capped at
 * 90% of the viewport): BURIED behind the sheet is degraded but recoverable
 * (closing the sheet — X, or Esc with focus in it — reveals a fully-rendered,
 * answerable card), and it is the geometry this branch shipped with before the
 * dodge existed at all.
 */
export const GATE_PANEL_DODGE_BREAKPOINT = SUBAGENT_SHEET_WIDTH + GATE_PANEL_MIN_WIDTH;

/**
 * The sheet's fixed-width utility, and the panel's own width utility: the panel
 * is the same width as the sheet BY DESIGN (both are right-anchored and this wide
 * — which is exactly why an open sheet covers a corner panel completely), so the
 * two surfaces share ONE literal and `SubagentModals.test.tsx` can pin that they
 * still do.
 *
 * The declared type is what forces the literal to keep saying 480: see the
 * module doc.
 */
export const SHEET_WIDTH_CLASS: `w-[${typeof SUBAGENT_SHEET_WIDTH}px]` = "w-[480px]";

/**
 * The dodge's offset half: park the panel at the sheet's LEFT edge. Always used
 * behind the `min-[…]` variant of `GATE_PANEL_DODGE_BREAKPOINT` — never
 * unconditionally, because below the breakpoint that same pair is a zero-width
 * box positioned off-viewport (see `GATE_PANEL_DODGE_BREAKPOINT`).
 */
export const GATE_PANEL_DODGE_OFFSET_CLASS:
  `min-[${typeof GATE_PANEL_DODGE_BREAKPOINT}px]:right-[${typeof SUBAGENT_SHEET_WIDTH}px]` =
  "min-[760px]:right-[480px]";

/**
 * The dodge's width half: cap the panel at the room left over beside the sheet,
 * so the offset cannot hang it off the viewport's LEFT edge (the default window
 * is 800px wide). Same variant gate, same reason, and it travels with
 * `GATE_PANEL_DODGE_OFFSET_CLASS` — one is meaningless without the other, which
 * is why they are applied as a pair and pinned as a pair.
 */
export const GATE_PANEL_DODGE_MAX_WIDTH_CLASS:
  `min-[${typeof GATE_PANEL_DODGE_BREAKPOINT}px]:max-w-[calc(100vw-${typeof SUBAGENT_SHEET_WIDTH}px)]` =
  "min-[760px]:max-w-[calc(100vw-480px)]";
