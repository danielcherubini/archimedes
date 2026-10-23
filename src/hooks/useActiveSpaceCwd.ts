import { useSessions } from "../store/sessions";
import { sessionFieldOf } from "../lib/sessionLookup";

/**
 * The active **Session**'s `cwd` — which IS its **Space**'s folder (CONTEXT.md) —
 * or `null` when there is no active Session.
 *
 * This is the ONE place that derivation lives, and it has two consumers that
 * need the same fact for the same reason:
 * - `ChatStream`'s `spacePath`, the key the `$`/`#`/`@`/`?` picker catalogs are
 *   cached under (`useMentionCatalogs`);
 * - `App`'s `SpaceCwdProvider`, which is what every **External open** of a
 *   relative path resolves against (`OpenAnchor`, and the tool-output / chip /
 *   thinking surfaces that follow it).
 * Before this module existed, `ChatStream` derived it inline; a second
 * consumer re-deriving it is how the two silently disagree, so the rule is one
 * module, not one selector per component.
 *
 * The WALK itself (live → stored → archived, live winning over a stored row with
 * the same id, and BOTH stored lists covered) belongs to
 * `lib/sessionLookup.ts` now — the same rule five other call sites needed. It
 * matters here that archived is reached at all: a session opened from the
 * Archived section lives only in `archivedSessions`, so a `historySessions`-only
 * lookup would resolve `null` for it and make every relative path in its
 * transcript unopenable (`external_open` refuses a relative path with no cwd —
 * the safe direction, but a needless dead surface).
 *
 * A **Subagent session** needs no special case: its Worker runs with
 * `cwd = parent_cwd`, so the active Space's cwd is correct for its transcript
 * too — which is what lets the provider sit in `App` (a Sibling of the
 * workspace view, so the transcript sheet is inside it) instead of in
 * `ChatStream`.
 *
 * The selector returns `string | null` DIRECTLY, never a fresh object or array:
 * a selector whose result is a new reference every call makes Zustand re-render
 * forever (the rule stated at `ChatStream.tsx:80-81`, and breaking it hangs the
 * test suite rather than failing it). `sessionFieldOf` returns the row's own
 * field, so the `?? null` below is the only value this creates.
 */
export function useActiveSpaceCwd(): string | null {
  return useSessions(
    (s) => sessionFieldOf(s, s.activeSessionId, "cwd") ?? null,
  );
}
