/**
 * The left pane's (the `SpacesList` sidebar's) collapsed flag — a tiny
 * shared module (no store, no React) mirroring `sidePaneState` (the right
 * pane): the chrome bar's `ChromeControls` toggle WRITES it and the sidebar
 * READS it, both through `useSyncExternalStore(subscribeLeftPane,
 * getLeftPaneCollapsed)`. The pane and its control are separate components on
 * purpose — the control belongs to the window, not to the surface it hides, so
 * it never moves when the pane collapses.
 *
 * The module is the SINGLE OWNER of the persistence: `setLeftPaneCollapsed`
 * writes `localStorage["left-pane-collapse"]` itself, so the toggle's
 * `setLeftPaneCollapsed(!collapsed)` reaches localStorage with no extra
 * step. The module SEEDS the flag from the persisted value at import
 * (no mount-time hydration elsewhere — a re-read would be a no-op echo
 * unless storage and memory disagree, in which case it would clobber the
 * live flag). The `setItem` is guarded: a quota/lockdown throw must not
 * take down the toggle's click handler (the state flip + notify still
 * happen).
 */

const STORAGE_KEY = "left-pane-collapse";

/**
 * The sidebar's expanded width — shared with the `App` chrome bar: the
 * chrome bar's logo segment (the drag region) is the sidebar's width,
 * so the tabs start where the center column begins; the segment follows the
 * sidebar's collapse state (260px expanded, `LEFT_PANE_RAIL` collapsed).
 */
export const LEFT_PANE_WIDTH = 260;

/**
 * The width the sidebar keeps while COLLAPSED — a sliver, NOT 0.
 *
 * The sliver is now the room the collapsed rail draws in: the session marks and
 * the pane's three command icons (`SessionRail`), which need a 24px column plus
 * breathing room (24px `size-6` + 8px each side). It used to be justified as
 * the room for the pane's OWN collapse toggle in the inner-bottom corner; that
 * button lives in the chrome bar now, and the rail still needs the width — so
 * collapsing to 0 would take the marks and the commands with it.
 */
export const LEFT_PANE_RAIL = 40;

let collapsed =
  typeof localStorage !== "undefined" &&
  localStorage.getItem(STORAGE_KEY) === "true";

const listeners = new Set<() => void>();

export function getLeftPaneCollapsed(): boolean {
  return collapsed;
}

export function setLeftPaneCollapsed(v: boolean): void {
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

export function subscribeLeftPane(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
