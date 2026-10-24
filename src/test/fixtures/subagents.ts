import type { SubagentEntry } from "../../store/subagents";

/**
 * Subagent fixtures (a **Subagent session** + the directory that holds them).
 *
 * `SubagentEntry.startedAt`/`endedAt` are stamped by the STORE from
 * `Date.now()` (`store/subagents.ts`), so a test that seeds the store directly
 * has to supply them itself — and a `Date.now()` default would make any
 * elapsed-time assertion non-reproducible. Hence the fixed stamps below: a test
 * that cares about the clock passes its own.
 *
 * Import from a `vi.mock` factory with `await import()` — see the hoisting note
 * in `./settings.ts`.
 */

/**
 * One directory entry. Defaults to a RUNNING child, because that is the state a
 * `subagent-session-started` frame leaves behind; a closed child is what
 * `markClosed` produces, and `endedAt`/`metrics` belong to THAT state, so they
 * stay absent here.
 */
export function makeSubagentEntry(
  overrides: Partial<SubagentEntry> = {},
): SubagentEntry {
  const entry: SubagentEntry = {
    sessionId: "child-1",
    parentSessionId: "s1",
    agentName: "scout",
    task: "Review the diff",
    status: "running",
    startedAt: 1_000,
    ...overrides,
  };
  // A RUNNING child has no close stamp, no metrics and no failure code. Drop
  // them when a caller passes them as explicitly-`undefined`, so the entry
  // matches what the store actually holds (the card branches on
  // `entry.reason ?? entry.error`, and an `undefined`-valued key reads
  // differently to an absent one in an `in`/spread-based assertion).
  // `nameResolution` belongs to the STARTED frame, not to any status, and is
  // absent unless a caller names it (an older backend omits it).
  for (const optional of [
    "endedAt",
    "metrics",
    "reason",
    "error",
    "nameResolution",
  ] as const) {
    if (optional in entry && entry[optional] === undefined) {
      delete entry[optional];
    }
  }
  return entry;
}

/**
 * The whole subagent directory (`useSubagents`'s `entries` slice — the store
 * does not export its state interface, so this names the one field).
 *
 * Entries are keyed by `sessionId` (insertion order = arrival order — the
 * directory's ordering rule), so the key is never a caller-supplied second
 * argument that could disagree with the entry it files.
 */
export function makeSubagentState(
  entries: readonly SubagentEntry[] = [],
): { entries: Record<string, SubagentEntry> } {
  const byId: Record<string, SubagentEntry> = {};
  for (const entry of entries) byId[entry.sessionId] = entry;
  return { entries: byId };
}
