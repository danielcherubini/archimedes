import type { SessionConfigOption, SessionInfo } from "./tauri";

/**
 * The same three-list walk, spelled once.
 *
 * Six places each re-derived "find this id in `sessions`, else in
 * `historySessions`, else in `archivedSessions`" and then picked a different
 * field out of whatever they found: `cwd` twice (`useActiveSpaceCwd.ts`,
 * `SidePane.tsx`), `configOptions` and `contextUsage` (`sessionConfig.ts`), the
 * stored row's `capabilities` (`ChatStream.tsx`), and `title` twice
 * (`SidePane.tsx`'s header and `SpacesList.tsx`'s session row).
 * `useActiveSpaceCwd.ts` already stated why one owner is required — "a second
 * consumer re-deriving it is how the two silently disagree" — and the copies
 * proved it: they disagreed about whether `archivedSessions` belonged to the
 * walk at all, which is the bug where an archived session's context bar reads
 * 0% and its selectors fall back to empty stubs.
 *
 * WHY a plain function and NOT a hook (the shape `sessionConfig.ts` already
 * modelled): a caller invokes it INSIDE its own zustand selector, so each
 * component subscribes to exactly the VALUE it renders and re-renders only when
 * that value changes. A hook would force every consumer to subscribe to
 * `activeSessionId` plus all three lists — including lists a component never
 * shows (the side pane shows no session list at all).
 *
 * TWO INVARIANTS, each easy to break and hard to notice:
 *
 *  1. **The order is load-bearing**: live → history → archived. A live row wins
 *     over a stored row with the same id (the live row is current truth — a
 *     resume can move a Session between Spaces), and `archivedSessions` must be
 *     reached at all: an archived session opened from the Archived section lives
 *     ONLY there.
 *  2. **It returns the FIELD, never the row and never a `{ … }` object.**
 *     zustand v5 re-runs a selector that yields a fresh object on every snapshot
 *     read, so such a selector re-renders its component forever — a symptom that
 *     HANGS the test suite rather than failing it. (`SidePane.tsx` states this
 *     where it keeps `cwd` and `title` as two separate primitive selectors.)
 *     Handing back the row's OWN field keeps the reference stable, because the
 *     returned value IS the stored object.
 *
 * The EMPTY case is `undefined`, and this module deliberately does not flatten
 * it into `null` or `[]`: what "nothing knows this id" renders as belongs to the
 * caller. `sessionConfigOptionsOf` therefore keeps its own `?? null` tail, so
 * "no config at all" stays distinguishable from "a config with zero options".
 */

/**
 * The row shape the walk reads.
 *
 * ⚠️ Deliberately WIDER than the `Pick` `sessionConfig.ts` used for its own two
 * derivations (`sessionId | configOptions | contextUsage`), and the reason is
 * arithmetic rather than taste: a `Pick` that omits `cwd` and `title` cannot
 * type a walk whose callers read `cwd` and `title`. So the shared row adds:
 *  - `cwd` + `title` — what `useActiveSpaceCwd.ts`, `SidePane.tsx` (twice) and
 *    `SpacesList.tsx` walk for, and
 *  - `capabilities` — what `ChatStream.tsx` walks for (its image gate and its
 *    `loadSession` resume gate). It replaces a selector that returned the whole
 *    ROW, the exact shape invariant 2 forbids.
 *
 * `archived` stays OUT: no walk reads it, and leaving it out is what lets a test
 * build a row without inventing flags it does not care about. Structurally
 * compatible with the store's `SessionInfo[]`, so every call site passes
 * `s.sessions` / `s.historySessions` / `s.archivedSessions` unchanged.
 */
export type SessionRow = Pick<
  SessionInfo,
  | "sessionId"
  | "cwd"
  | "capabilities"
  | "title"
  | "configOptions"
  | "contextUsage"
>;

/**
 * The slice of the `useSessions` state the walk reads. Structural, not
 * `SessionsState` (the store does not export it): a component passes its WHOLE
 * state object from inside a selector — the store's other keys are simply not
 * part of the parameter type — and a test builds a plain one.
 */
export interface SessionLookupSource {
  /** Live (in-memory) sessions for this app run — the CURRENT truth. */
  sessions: SessionRow[];
  /** Stored sessions (archived flag OFF) that are not currently live. */
  historySessions: SessionRow[];
  /** Stored sessions with the archived flag ON — the list a partial walk misses. */
  archivedSessions: SessionRow[];
}

/**
 * The state shape `lib/sessionConfig.ts`'s map-first derivations walk: the three
 * lists (owned by {@link SessionLookupSource}, so the two shapes cannot drift)
 * plus the two per-id maps those derivations prefer over any row.
 *
 * It lives HERE rather than in `sessionConfig.ts` so this module owns the whole
 * walk's input contract; `sessionConfig.ts` re-exports the name for its
 * existing consumers.
 */
export interface SessionConfigSource extends SessionLookupSource {
  /** The live frames' config options, per session id. */
  configOptions: Record<string, SessionConfigOption[]>;
  /** The live frames' context usage, per session id. */
  contextUsage: Record<string, { used: number; window: number } | undefined>;
}

/**
 * Read ONE field of one Session across the three lists, live → history →
 * archived.
 *
 * `??` semantics throughout, which is what all six walks it replaces did: a row
 * that exists but holds `null`/`undefined` in the field is a GAP, so the next
 * list gets its turn, while a falsy-but-present value (`""`, an empty
 * `configOptions` array, `0`) is a VALUE and stops the walk. That distinction is
 * the caller's to interpret — hence the `undefined` return and no synthesized
 * `null` or `[]` here.
 *
 * @param s    the state (or any object with the three lists)
 * @param id   the session id; `null` / `undefined` / `""` means "no active
 *             session" and the lists are not read at all
 * @param key  the ONE field to read
 * @returns the FIELD (`SessionRow[K]`), by reference, or `undefined` when no
 *          list knows the id or no known row carries the field.
 */
export function sessionFieldOf<K extends keyof SessionRow>(
  s: SessionLookupSource,
  id: string | null | undefined,
  key: K,
): SessionRow[K] | undefined {
  if (!id) return undefined;
  // The order IS the rule (see the module doc): live wins, and archived is last
  // — but never absent.
  for (const rows of [s.sessions, s.historySessions, s.archivedSessions]) {
    const value = rows.find((x) => x.sessionId === id)?.[key];
    // `!== null && !== undefined` (i.e. `??`'s own test, not a truthiness test)
    // so an explicit `null` — which `SessionInfo.title` allows — falls through
    // exactly as it did in every walk this replaces.
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}
