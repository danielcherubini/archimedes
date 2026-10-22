import type { ReactElement } from "react";
import { cn } from "./lib/utils";

/**
 * The ONE inline IPC-error line: a small destructive-ink sentence that a screen
 * reader actually announces.
 *
 * WHY THIS EXISTS (finding 7). Nine surfaces render the reason an IPC call
 * failed — a permission prompt that would not answer, a sudo modal whose
 * response was rejected, a paste the composer refused, an update check that
 * could not reach the server. All nine rendered it as a bare `<p>` with
 * `text-destructive`, so the error arrived in the visual layer ONLY: no
 * `role="alert"`, no live region, no announcement. A sighted user saw red text
 * appear under their cursor; a screen-reader user did nothing at all and had no
 * way to know the click had failed. This repo already knows that a message the
 * user must react to needs a live region — `SessionStalledBanner.tsx:34` and
 * `NewSessionErrorBanner.tsx:61` are both `role="alert"` strips — so the inline
 * errors were the inconsistency, not a deliberate choice. Migrating onto this
 * component is therefore a BEHAVIOUR CHANGE (nine surfaces gain announcements)
 * and is deliberately committed one site at a time. See ADR 0063 for what the
 * string itself is allowed to say.
 *
 * WHY A COMPONENT AND NOT NINE ATTRIBUTES. The class pair
 * `text-ui-sm text-destructive` was spelled out at every site, and `className`
 * is exactly the thing a hand-written copy gets wrong when it grows a padding
 * (the `cn` merge rules in `lib/utils.ts` are what makes a caller's override
 * behave; a raw template literal has no such rules). One component means the
 * `role` cannot be forgotten at the tenth site.
 *
 * THE `role="alert"` IS NOT FREE, and that is the reason this file is careful
 * about `null`. An `alert` region mounted at page load announces whatever lands
 * in it later; an empty one is noise. So no error → no element at all, which
 * also keeps every site's `{error && …}` guard meaningful rather than doubled.
 * Note `SessionConfigSelect.tsx:254`/`:310` already carry their own
 * `role="alert"` and are NOT migrated here (Task C1 owns that component) — do
 * not add a second `IpcErrorLine` to a tree that renders those two spans, or a
 * `getByRole("alert")` in a test starts throwing on multiple matches.
 *
 * `as` EXISTS BECAUSE THE SITES ARE NOT ALL BLOCKS. Every one of the nine is a
 * `<p>` today, so `<p>` is the default and the migrations are element-neutral.
 * The option is here for the site that cannot be a `<p>`: a `<p>` nested in a
 * `<p>` is invalid HTML, React's parser recovery moves the DOM behind the
 * component's back, and the byte-identical-spacing claim would be false. A
 * caller in that position passes `as="span"` rather than restructuring its
 * parent for a11y's sake.
 */
export function IpcErrorLine({
  error,
  className,
  as: Element = "p",
}: {
  /** The message to show — the `describeIpcError(err)` string the caller stored.
   * `null` / `undefined` / `""` render NOTHING (no element, so no empty alert). */
  error: string | null | undefined;
  /** Per-site spacing or size, merged through `cn` so it can override the
   * default font size without dropping the destructive colour. */
  className?: string;
  /** The element to render. `<p>` matches every current site; `"span"` is for a
   * line that has to sit inside a block element. */
  as?: "p" | "span";
}): ReactElement | null {
  if (!error) return null;
  return (
    <Element role="alert" className={cn("text-ui-sm text-destructive", className)}>
      {error}
    </Element>
  );
}
