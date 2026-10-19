import { useMemo } from "react";
import { childGatesOf } from "./useChildGates";
import { useSubagents } from "../store/subagents";
import { useInteractive } from "../store/interactive";
import { usePermissions } from "../store/permissions";

/**
 * How many gates the user owes a `Subagent session` — app-wide: `useInteractive`
 * `ask`/`confirm`/`password` requests + `usePermissions` prompts held by any
 * session that has a `useSubagents` entry. `useHasPendingRequest` turns this
 * number into the boolean behind the collapsed-pane cues — the chrome bar's two
 * `bg-warning` pane-toggle dots (`ChromeControls`) plus `ChatStream`'s hint
 * suppression — so they cannot disagree (moved here for exactly that reason). The "Waiting"
 * pill on a session row is a DIFFERENT surface: `SessionRow` in `SpacesList`
 * reads `useSessionStatus`, which counts the same gates through the same pure
 * core (`childGatesOf`) but is not a consumer of this hook.
 *
 * It is `childGatesOf(…, null).length` — the all-children set — and NOTHING
 * else. That set is exactly the UNION of the two render sites (the inline card
 * in the active parent's transcript + the overlay for every other parent), so
 * the count can neither drop a gate nor double-count one. Summing
 * `useChildGates(activeSessionId).length` with a second pass over the rest would
 * be the tempting derivation, and it is the one that double-counts.
 *
 * The scope is deliberately APP-WIDE, and that is now CORRECT rather than
 * approximate: the always-mounted overlay genuinely surfaces every NON-active
 * parent's gates, so "you owe something, somewhere" matches what is on screen.
 * (The old justification — "a subagent session id is never the ACTIVE session,
 * so a per-active-session count sees nothing" — described why the shortcut was
 * necessary, not why the wide scope is right; the cue's job was always to say
 * that a gate is waiting, never which Session holds it. Attribution is the
 * inline card's and the parent row's status' job, not the dot's.)
 *
 * A gate whose child has no `SubagentEntry` is NOT counted — see `childGatesOf`
 * for why an unknown parent owns no gate.
 *
 * MEMOISED on the three store references, like `useChildGates` (see the cost
 * sentence there). This one is the hottest of the gate derivations rather than
 * the widest-scoped: `useHasPendingRequest` calls it, and its three callers are
 * `ChatStream` — which re-renders on every streamed token and every composer
 * keystroke — plus the chrome bar's two pane toggles. Unmemoised, that was
 * a `ChildGate` allocation per gate plus a sort per render, for an answer that
 * only moves when one of the three maps is replaced. `useMemo` is a hint React
 * may in principle discard, so nothing reads this number as correctness — it is
 * the count itself that is load-bearing, and the memo only removes work.
 */
export function usePendingSubagentRequests(): number {
  // Selectors return the STORE's own slices — never a `?? {}` fallback inside a
  // selector, which would mint a fresh object per call and re-render forever.
  const entries = useSubagents((s) => s.entries);
  const requests = useInteractive((s) => s.requests);
  const prompts = usePermissions((s) => s.prompts);
  // `null` = EVERY child, regardless of parent (the hook's own `null` means the
  // opposite — `[]` — which is why this calls the pure core, not the hook).
  // The keys are exactly the three values this hook subscribes to, so the
  // derivation re-runs precisely when its inputs could have changed; the answer
  // is a `number`, so there is no array identity to keep stable here (the
  // `NO_GATES` trick in `useChildGates` has nothing to buy at this site).
  return useMemo(
    () => childGatesOf(entries, requests, prompts, null).length,
    [entries, requests, prompts],
  );
}
