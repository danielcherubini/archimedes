import type { ReactNode } from "react";

import { cn } from "./lib/utils";

/**
 * The quiet one-line caption: `text-ui-xs text-foreground-subtlest`, once.
 *
 * WHY THIS EXISTS (finding 15). That exact pair was spelled by hand at 10
 * places across 7 files — a Skill row's `global` scope badge and its
 * `manual only` badge, an agent row's `global` badge and its stale-override
 * note, the `Queued` label on a queued prompt, the `named by the user` hint on a
 * mention chip, a subagent transcript's metrics line, a todo header's
 * `3/7` count, an ask card's `Enter submit · Esc cancel` footer hint, a sudo
 * modal's key hint. A tenth site is a copy-paste away from `text-ui-sm`, or from
 * `text-foreground-subtle`, and nothing in this repo would notice: there is no
 * linter or formatter configured (`package.json` and `Makefile:check` run
 * `tsc` + `vite build` + `vitest` and nothing else), so a caption drifting a
 * half-step quieter than its neighbour is invisible to every gate. One component
 * means the pair cannot be mistyped at site eleven.
 *
 * WHY A COMPONENT AND NOT A CLASS CONSTANT. `TRANSCRIPT_ROW`
 * (`components/lib/transcriptRow.ts`) is the constant form of this idea, and it
 * works there because that row's consumers are three siblings of one shape.
 * These ten are not: they are a `<span>` here, a `<p>` there, one with
 * `min-w-0 truncate`, one with `shrink-0`, one with a `title`. A constant fixes
 * the string but leaves every site to remember the element and to concatenate
 * correctly — which is the exact hand-rolled `className` template literal this
 * whole task is removing. The component owns the pair AND routes the differences
 * through `cn()`, so a caller's `className` behaves like every other `cn` merge
 * in the app (later same-group utility wins) instead of relying on CSS source
 * order.
 *
 * NO ELEMENT OF ITS OWN. It renders the caption and nothing around it. Every
 * consumer sits in a flex row whose item classes (`shrink-0`, `min-w-0`,
 * `truncate`) are load-bearing for truncation, and a wrapper div would take the
 * caption out of that row — the `min-w-0`/`truncate` pairing documented in
 * `ComposerMentions.tsx` is precisely what a wrapper would break.
 *
 * `as` EXISTS BECAUSE THE SITES ARE NOT ALL INLINE. `span` is the default (7 of
 * the 10 verbatim sites are spans); `p` is for the caption that owns a line (the
 * ask card's and the sudo modal's footer hints, the transcript's metrics).
 * A caller picks the element the surrounding markup requires — never to change
 * the visual, which is identical either way.
 */
export function MutedCaption({
  children,
  className,
  title,
  as: Element = "span",
}: {
  children: ReactNode;
  /** Caller geometry (`shrink-0`, `min-w-0 truncate`, …) merged through `cn()`.
   * A same-group utility here REPLACES the caption's own — that is `cn`'s
   * contract, and `MutedCaption.test.tsx` pins it. */
  className?: string;
  /** The tooltip, when the caption needs one (the `manual only` badge). */
  title?: string;
  /** `span` (the default — an inline badge) or `p` (a caption on its own line). */
  as?: "span" | "p";
}) {
  return (
    <Element
      title={title}
      className={cn("text-ui-xs text-foreground-subtlest", className)}
    >
      {children}
    </Element>
  );
}
