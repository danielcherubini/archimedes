/**
 * THE CHROME-BAR BUTTON GRAMMAR — a class CONSTANT, deliberately not a component
 * (Finding 6a).
 *
 * Two clusters of small icon buttons sit at the right end of the frameless
 * window's top bar, and they share one geometry:
 *
 *   - **Chrome controls** (`ChromeControls`): the Settings gear and the two pane
 *     collapse toggles — CONTEXT.md's **Chrome controls**;
 *   - the **window controls** (`WindowControls`): Minimize / Maximize / Close.
 *
 * They face the same cursor in the same row, so their box, radius, ink and
 * colour transition are one fact, and that fact used to be spelled THREE times
 * (`ChromeControls`'s local `BTN`, and two literals in `WindowControls`).
 *
 * WHY A CONSTANT AND NOT A `<ChromeButton>` COMPONENT. The two clusters are
 * NOT one component, and the difference is blessed rather than accidental:
 *  - ADR 0038 puts the attention-alert exemption (`data-window-control`) on the
 *    `WindowControls` container ONLY, and `ChromeControls` sits OUTSIDE it on
 *    purpose — a component that "was the chrome button" would invite a caller to
 *    put the exemption on the button, which changes when the alert fires;
 *  - CONTEXT.md **Chrome controls** exists precisely to keep the two clusters
 *    distinct in the vocabulary (`_Avoid_: window controls`), and `App.test.tsx`
 *    pins that the chrome controls resolve OUTSIDE `[data-window-control]`;
 *  - the chrome controls carry an `absolute` pending dot, so they need
 *    `relative` and the window controls must not gain `position: relative`.
 * A component would have to model all three differences as props/children to be
 * usable, at which point it is a wrapper around a class string with extra steps.
 * The duplication Finding 6a names is the STRING, so the string is what moves.
 *
 * WHY `relative` IS NOT HERE. It belongs to the caller that owns an
 * absolutely-positioned child (the `bg-warning` pending dot). `WindowControls`
 * never had it, and a shared constant must not add a positioning context to a
 * button that did not have one. `ChromeControls` therefore renders
 * `cn("relative", CHROME_BUTTON)` — the same class list it rendered before.
 *
 * WHY THE TWO ARMS ARE TWO CONSTANTS AND NOT A BOOLEAN. `CHROME_BUTTON_CLOSE`
 * SWAPS the hover pair (`hover:bg-destructive/20 hover:text-destructive` for
 * `hover:bg-hover hover:text-foreground`) rather than adding to it — a Close
 * that also filled `bg-hover` would flash grey before red. `chromeButton.test.ts`
 * pins that geometry-vs-hover split; a `destructive?: boolean` prop would put it
 * in markup for no benefit, and C7 needs a plain `className` value.
 *
 * CONSUMER CONTRACT — read this before "deduplicating" another button onto it:
 * this is the CHROME BAR's grammar (`h-7 w-7`, `bg-hover`, `transition-colors`).
 * The tab strip's ✕ and `+` (`SpaceTabs.tsx`) are a DIFFERENT cluster with
 * `size-5`/`size-8`, `bg-surface-hover`, `rounded`/`rounded-md` and NO
 * `transition-colors`, and they stay that way on purpose. The same
 * `chromeButton.test.ts` guard reddens an import of this module there.
 *
 * C7 consumes these constants as the `className` on
 * `<Button variant="ghost" className={CHROME_BUTTON}>` — that is why they are
 * strings and stay strings.
 */

/**
 * The shared chrome-bar button: a 28px square, centred glyph, subtle ink that
 * lifts to full ink on a `bg-hover` fill, colour-transitioned.
 *
 * Byte-identical to the string `WindowControls`' Minimize and Maximize carried,
 * and to `ChromeControls`'s `BTN` minus `relative` (see above).
 */
export const CHROME_BUTTON =
  "flex h-7 w-7 items-center justify-center rounded-md text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground";

/** The Close control: `CHROME_BUTTON` with the hover pair swapped for destructive. */
export const CHROME_BUTTON_CLOSE =
  "flex h-7 w-7 items-center justify-center rounded-md text-foreground-subtle transition-colors hover:bg-destructive/20 hover:text-destructive";
