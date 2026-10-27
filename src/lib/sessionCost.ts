import type { CostUpdatePayload } from "../store/interactive";
import {
  sessionFieldOf,
  type SessionLookupSource,
} from "./sessionLookup";

/**
 * The SHARED derivation of the session's money (issue #105): the live
 * accumulator first, falling back to the stored row.
 *
 * WHY a plain function and NOT a hook — the same reasoning `sessionConfig.ts`
 * and `sessionLookup.ts` record: a caller invokes it INSIDE its own zustand
 * selector, so the component subscribes to the derived VALUE (a number or
 * `null`, a primitive) and re-renders only when that changes. A hook would force
 * every consumer to subscribe to `activeSessionId` plus all three session lists.
 * It is also what makes the precedence rule below testable with no DOM.
 *
 * It exists because the figure used to live in exactly one place —
 * `useInteractive.cost[sessionId]`, written by the `cost_update` frames — and
 * that map is in-memory only: `dismissSession` deletes the entry on close and
 * nothing persists it, so the number under a session's title evaporated on
 * reload (issue #105). The `sessions` row now carries the running figure, and
 * the row is the ONLY place a stored session's money exists: the map hydrator
 * (`mergeRefreshedSessionRows`) runs solely from Settings' provider refresh, so
 * boot hydrates no maps at all. A selector that read only the map would work
 * after opening Settings and nowhere else.
 *
 * THE TWO-HALF SHAPE IS THE `contextUsage` PRECEDENT (`contextUsageOf`,
 * `sessionConfig.ts`) — map first, then `sessionFieldOf` over
 * `sessions` → `historySessions` → `archivedSessions`. Only the PRECEDENCE RULE
 * differs, deliberately, and the comment on it below is the part to read before
 * "aligning" the two.
 */

/**
 * The session's USD figure, or `null` for "render nothing".
 *
 * @param interactive THIS session's live accumulator entry
 *                    (`useInteractive.cost[id]`, the store's own
 *                    {@link CostUpdatePayload} — `undefined` when no entry
 *                    exists, which is the case for a stored session at boot and
 *                    for every session after its close)
 * @param s           the three session lists (the walk's input shape)
 * @param id          the session id; `null`/`undefined` means "no active
 *                    session", and neither the entry nor the lists is read
 *
 * PRECEDENCE — keyed on the ENTRY'S EXISTENCE, and this deliberately differs
 * from `contextUsageOf`, which reads `s.contextUsage[id] ?? row`:
 *
 * ```ts
 * if (interactive !== undefined) return interactive.costUsd ?? null;
 * return sessionFieldOf(s, id, "costUsd") ?? null;
 * ```
 *
 * An entry that EXISTS with `costUsd: null` is not a gap — it is a report.
 * `applyCost` normalises every frame and writes `costUsd: null` when no frame
 * this session carried a figure (D5, and `CostUpdatePayload`'s own doc calls
 * `null` "a REACHABLE, MEANINGFUL value"), so the entry means "this session is
 * live and is reporting nothing TODAY". Copying `contextUsageOf`'s `??` there
 * would fall through to the stored row and RESURRECT an old figure over a live
 * session that reports nothing — manufacturing money the provider did not send
 * this run, which is the exact defect class #87 was filed to end. Context usage
 * has no such state to protect: an absent usage simply means "no frame yet", so
 * `??` is right for it and wrong here. Do not "align" the two.
 *
 * MONEY ONLY, by decision: there is nothing here to fall back to for tokens,
 * and the plan's fact 3 keeps token fields off the row entirely so
 * `SubagentDelegatingCard`'s context-% chain keeps falling through to its own
 * (correct) sources.
 */
export function costUsdOf(
  interactive: CostUpdatePayload | undefined,
  s: SessionLookupSource,
  id: string | null | undefined,
): number | null {
  if (id === null || id === undefined) return null;
  if (interactive !== undefined) return interactive.costUsd ?? null;
  // `sessionFieldOf`'s gap test is `??`-style, not a truthiness test, so a
  // stored `0` — a REAL zero — is a value and stops the walk rather than being
  // skipped as a gap. The `?? null` tail belongs here and not in the walk: the
  // walk's empty case is `undefined`, and what "missing" renders as belongs to
  // the caller (the same division `sessionConfigOptionsOf` keeps).
  return sessionFieldOf(s, id, "costUsd") ?? null;
}
