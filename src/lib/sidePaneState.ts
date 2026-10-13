/**
 * The side pane's collapsed flag — a tiny shared module (no store, no
 * React) so the two halves of the `SidePane` frame agree without event
 * guessing: the pane keeps its OWN collapse toggle — at the frame's
 * inner-bottom corner, in BOTH states, and the chrome bar holds no pane
 * control at all (`CONTEXT.md`: **Side pane**) — so the frame reads this
 * flag via `useSyncExternalStore(subscribeSidePane, getSidePaneCollapsed)`
 * and its toggle is the only thing that writes it.
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
 * The width the side pane keeps while COLLAPSED — a sliver, NOT 0. The pane's
 * collapse toggle lives in its own inner-bottom corner (bottom LEFT) and stays
 * there in both states, so the sliver is the room that keeps it on screen
 * (24px button + 8px inset + 8px of breathing room). Collapsing to 0 would
 * clip the toggle away with the pane, and no keyboard shortcut exists — see
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
