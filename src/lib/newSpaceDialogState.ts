/**
 * The Open Space dialog's open flag — a tiny shared module (no store, no
 * React) mirroring `leftPaneState` / `sidePaneState`, and for the same reason:
 * the flag needs ONE owner across a subtree that unmounts.
 *
 * WHY A MODULE AND NOT A `useState`: four surfaces raise this dialog — the
 * `App`-root chord listener (which has no component closure it could call for
 * the flag, because the sidebar it used to live in is unmounted in the
 * Settings view), the root-rendered dialog itself, the sidebar's `Open Space`
 * button and rail icon, and the tab strip's `+`. A `useState` in any one of
 * them is invisible to the others, and two owners of one dialog is how two
 * dialogs end up mounted at once (`getByText("New space")` → "Found multiple
 * elements"). `SpacesList` unmounts when the Settings page opens, so the flag
 * cannot live there either — it has to outlive the pane that used to own it.
 *
 * NOTHING IS PERSISTED, and that is the whole difference from `leftPaneState`:
 * no `STORAGE_KEY`, no `localStorage`, no seeding at import. A collapsed pane
 * is the shape the user left the app in; a dialog restored OPEN on launch
 * blocks the window before the user has done anything, so the value is not
 * worth a round trip to storage.
 *
 * ⚠ THE FLAG IS MODULE-SCOPED: it outlives every component and every test
 * case. Any test file that can open the dialog must close it again in a
 * FILE-LEVEL `beforeEach` — a leaked `true` makes every later `render()` in
 * that file auto-mount a real Radix modal, which `aria-hidden`s the rest of
 * the document and sets `document.body.style.pointerEvents = "none"`, so
 * unrelated `getByRole` queries start throwing for the wrong-looking reason.
 */

let open = false;

const listeners = new Set<() => void>();

export function getNewSpaceDialogOpen(): boolean {
  return open;
}

export function setNewSpaceDialogOpen(v: boolean): void {
  if (v === open) return; // same-value echo: no notify
  open = v;
  for (const fn of [...listeners]) fn();
}

/**
 * The zero-arg opener. NOT sugar for `setNewSpaceDialogOpen(true)`: the flag
 * setter takes an argument, so it is assignable to neither `() => void` (a
 * `SessionRailAction.onClick`) nor `MouseEventHandler` (a button's `onClick`)
 * — `TS2322` both ways. Every call site here is one of those two shapes.
 */
export function openNewSpaceDialog(): void {
  setNewSpaceDialogOpen(true);
}

export function subscribeNewSpaceDialog(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
