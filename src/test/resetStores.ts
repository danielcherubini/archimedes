import { useSessions } from "../store/sessions";
import { useSettings } from "../store/settings";
import { useSubagents } from "../store/subagents";
import { useInteractive } from "../store/interactive";
import { useSubagentSelection } from "../store/subagentSelection";
import { useQueuedPrompts } from "../store/queuedPrompts";
import { usePermissions } from "../store/permissions";
import {
  getLeftPaneCollapsed,
  setLeftPaneCollapsed,
} from "../lib/leftPaneState";
import {
  getSidePaneCollapsed,
  setSidePaneCollapsed,
} from "../lib/sidePaneState";
import { setNewSpaceDialogOpen } from "../lib/newSpaceDialogState";
import type { StoreApi } from "zustand";

/**
 * The store half of test isolation.
 *
 * WHY THIS EXISTS. Every test file that touches a store currently hand-writes a
 * `beforeEach` with the keys it happens to remember, and `sessions.ts` has more
 * data fields than any such list names — so whichever fields the hand-written
 * version of `SpaceTabs.test.tsx`'s reset left out (`history`, `contextUsage`,
 * `compacting`, `inTurn`, `stopReasons`, `stalled`, `newSessionError`, …) leaked
 * from one case to the next inside a file, which is how a test starts passing
 * for a reason nobody intends. This resets every store to the state zustand
 * itself captured at creation, so the list of fields is not something a test has
 * to remember. No comment here quotes HOW MANY data fields a store has, on
 * purpose: the count is a property of the store, it changes the moment a field
 * is added, and every file that repeats the number has to be found and corrected
 * when it does — which is the same failure this module exists to end.
 *
 * THREE THINGS THIS DOES **NOT** DO — read these before trusting it.
 *
 *  1. It does not MERGE. `zustand`'s `setState` SHALLOW-MERGES by default, so a
 *     reset written as `setState({ sessions: [] })` leaves every other dirty key
 *     standing. That is the bug this module exists to avoid, so each reset here
 *     passes `replace = true` and installs the WHOLE captured initial state.
 *     A caller adding a partial reset in a test file re-introduces the hazard.
 *
 *  2. It does not touch MODULE-SCOPE state, because it cannot: a module `let`
 *     is not store state. `src/store/sessions.ts` holds four of them —
 *     `inFlightToggles` (`:598`), `committedTrusted` (`:606`),
 *     `newSessionInFlight` (`:612`) and `clientMessageSeq` (`:620`) — and none
 *     is exported, so nothing outside that file can reach them. The name is
 *     therefore deliberately `resetStores`, not `resetGlobalState`: a test that
 *     needs one of those cleared needs a named reset exported from
 *     `sessions.ts`, which is a change to the store, not to this file.
 *     `src/test/fixtures.test.ts` pins the limitation with a live check on
 *     `clientMessageSeq`, so the name cannot quietly promise more than it does.
 *
 *  3. It does not reset the pane/dialog flags — those are the module-scope
 *     state that IS reachable, and they get their own named function,
 *     `resetModuleFlags()` below. They stay separate on purpose: the pane flags
 *     persist to `localStorage` and seed themselves from it at import, so
 *     "clean" for them means "back to the value at import", not `false`.
 */

/** The seven stores, listed once. Verified complete: `grep -rn 'create<' src/store`.
 *
 * Typed as `StoreApi<unknown>[]` rather than left to inference: the seven state
 * types differ, so an inferred array has a UNION element type, and calling
 * `setState` on a union of differently-typed signatures is a `tsc` error ("Each
 * member of the union type has signatures, but none of those signatures are
 * compatible"). `unknown` is sound here because the value passed to `setState`
 * is that same store's own `getInitialState()` result. */
const ALL_STORES: readonly StoreApi<unknown>[] = [
  useSessions,
  useSettings,
  useSubagents,
  useInteractive,
  useSubagentSelection,
  useQueuedPrompts,
  usePermissions,
];

/**
 * Restore every store to the state it was created with.
 *
 * `getInitialState()` is zustand's own capture of the object the `create`
 * callback returned, so the initial shape is never restated here (a hand-written
 * "initial" would drift the first time a field is added to a store). Passing
 * `replace = true` installs it wholesale — see the no-merge note above. The
 * actions ride along in that same object, so they stay callable afterwards.
 */
export function resetStores(): void {
  for (const store of ALL_STORES) {
    store.setState(store.getInitialState(), true);
  }
}

/**
 * The three module-scope UI flags, captured at THIS module's import time.
 *
 * `leftPaneState` and `sidePaneState` seed their flag from `localStorage` when
 * they are first imported, so the value that counts as "clean" is whatever they
 * held then — NOT `false`. Hardcoding `false` would make a test that runs after
 * a persisted-`true` state fail for a reason outside its own control.
 */
const INITIAL_LEFT_PANE_COLLAPSED = getLeftPaneCollapsed();
const INITIAL_SIDE_PANE_COLLAPSED = getSidePaneCollapsed();

/**
 * Put the three shared module flags back the way they were at import.
 *
 * These are the flags ~48 test files reset by hand today, and the one that
 * bites hardest is the dialog: `newSpaceDialogState`'s flag is module-scoped, so
 * a leaked `true` auto-mounts a real Radix modal in every later `render()` in
 * the file, which `aria-hidden`s the document and sets
 * `document.body.style.pointerEvents = "none"` — and the next `getByRole` throws
 * for a reason that looks nothing like a leaked dialog.
 *
 * The pane setters write `localStorage` themselves, so restoring the flag keeps
 * storage and memory in agreement (the modules are the single owner of that
 * persistence; a reset that flipped the flag behind their back would not be).
 *
 * NOT covered: the `listeners` sets these three modules hold. Nothing outside
 * the modules can enumerate them, so a component that subscribes and never
 * unsubscribes leaves a listener here — it is a leak this helper cannot see.
 */
export function resetModuleFlags(): void {
  setLeftPaneCollapsed(INITIAL_LEFT_PANE_COLLAPSED);
  setSidePaneCollapsed(INITIAL_SIDE_PANE_COLLAPSED);
  // The dialog flag persists NOTHING (a dialog restored open on launch blocks
  // the window), so `false` is unambiguously its initial value.
  setNewSpaceDialogOpen(false);
}
