/**
 * The side pane's collapsed flag — a tiny shared module (no store, no
 * React) so the two halves of the arrangement agree without event guessing:
 * the chrome bar's `ChromeControls` toggle WRITES it and the `SidePane` frame
 * READS it, both via `useSyncExternalStore(subscribeSidePane,
 * getSidePaneCollapsed)`. The control lives OUTSIDE the pane on purpose — it
 * belongs to the window, not to the surface it hides, so it never moves when
 * the pane collapses (`CONTEXT.md`: **Side pane**). The pane's auto-open rule
 * (ADR 0042) is the module's only other writer, and it can only ever write
 * `false`.
 *
 * The module is the SINGLE OWNER of the persistence: `setSidePaneCollapsed`
 * writes `localStorage["side-pane-collapse"]` itself, so the toggle's
 * `setSidePaneCollapsed(!collapsed)` reaches localStorage with no extra
 * step. The module SEEDS the flag from the persisted value at import
 * (no mount-time hydration elsewhere — a re-read would be a no-op echo
 * unless storage and memory disagree, in which case it would clobber the
 * live flag). The `setItem` is guarded: a quota/lockdown throw must not
 * take down the toggle's click handler (the state flip + notify still
 * happen).
 */

const STORAGE_KEY = "side-pane-collapse";

let collapsed =
  typeof localStorage !== "undefined" &&
  localStorage.getItem(STORAGE_KEY) === "true";

const listeners = new Set<() => void>();

/**
 * The width the side pane keeps while COLLAPSED — a sliver, NOT 0. The sliver
 * is the room the todo rail's marks draw in (24px + 8px inset + 8px of
 * breathing room); collapsing to 0 would clip the overview away with the pane.
 * It used to be justified as the room for the pane's OWN collapse toggle in the
 * frame's inner-bottom corner; that button lives in the chrome bar's
 * `ChromeControls` now, and the rail still needs the width — see
 * `LEFT_PANE_RAIL` for the same decision on the left pane.
 */
export const SIDE_PANE_RAIL = 40;

export function getSidePaneCollapsed(): boolean {
  return collapsed;
}

export function setSidePaneCollapsed(v: boolean): void {
  if (v === collapsed) return; // same-value echo: no write, no notify
  collapsed = v;
  try {
    localStorage.setItem(STORAGE_KEY, String(v));
  } catch {
    // quota/lockdown: persistence is best-effort — the state flip and
    // the notify below still happen (the toggle's handler must NOT throw).
  }
  for (const fn of [...listeners]) fn();
}

export function subscribeSidePane(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
