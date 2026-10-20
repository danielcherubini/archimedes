import type { AgentOverride, AgentOverrides } from "../lib/tauri";

/**
 * The SHARED editor for `settings.json`'s `agentOverrides` map (ADR 0066) — the
 * rules every surface that edits the map must follow, held in ONE module so they
 * cannot drift. The sidebar **Agents** modal (`AgentsDialog`) is the only caller
 * today; the reason this is not inlined there is that the two rules that were
 * pinned by tests in the deleted Settings section (drop the ASCII case-fold
 * twin; delete an entry the moment it has no fields left) are exactly the two a
 * hand-assembled `{ ...map, [name]: { ...entry, [field]: value } }` spread gets
 * wrong. Build every write through `withOverride`.
 */

/**
 * ASCII-only case fold (mirrors the backend's `eq_ignore_ascii_case` — a
 * Unicode `toLowerCase()` would fold non-ASCII pairs the backend ignores).
 *
 * Exported, and VERBATIM from the deleted `SubagentSection.tsx` — the deleted
 * file's own commit message instructs that this comment travel rather than be
 * paraphrased, because the WHY (the two foldings diverge on non-ASCII input, and
 * the divergence is only visible with non-ASCII case pairs) is the part a
 * paraphrase loses.
 */
export function foldAscii(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * Set one field on one agent's override, immutably. Drops every ASCII case-fold
 * twin of the key (the backend's case-insensitive `.find` otherwise picks
 * between twins in nondeterministic HashMap order — see `SubagentSection.tsx`'s
 * deleted comment, copied here).
 *
 * `value === undefined` (or an empty array) DELETES the field; an entry left
 * with no fields is DELETED with it — ADR 0067, absence is the only meaning of
 * "this override does not speak". Never emit `null` for a field.
 */
export function withOverride(
  map: AgentOverrides,
  name: string,
  field: keyof AgentOverride,
  value: string | string[] | undefined,
): AgentOverrides {
  // ADR 0067: an EMPTY tools list speaks nothing, so it is treated as a CLEAR —
  // stored as absence rather than as `[]`. (A stored `[]` would resolve the same
  // way, the harness drops it — but it would leave the row's control claiming an
  // override that changes nothing, and the wire carrying a value the resolver
  // cannot mean.)
  const cleared = value === undefined || (Array.isArray(value) && value.length === 0);
  // The keys that ASCII-fold to `name`, in the map's own order. `folded` drives
  // both halves of the rule: the SIBLINGS carry over untouched ("leave every
  // other entry alone"), and the TWINS are the ones this write owns.
  const folded = foldAscii(name);
  const twins = Object.keys(map).filter((key) => foldAscii(key) === folded);
  const next: AgentOverrides = {};
  for (const [key, entry] of Object.entries(map)) {
    if (foldAscii(key) !== folded) next[key] = entry;
  }
  // One entry for the CANONICAL `name`, carrying the fields of the FIRST twin in
  // the map's own order — the SAME entry `AgentsDialog` displays in that row (its
  // lookup is the first fold-match, mirroring the deleted section's `find`). The
  // other twins are dropped WITHOUT merging their fields: a two-twin map is an
  // AMBIGUOUS stored state (the backend's `.find` picks between them by HashMap
  // luck), and the write's job is to end the ambiguity by picking the one answer
  // the user was looking at — not to invent a third entry out of both. This is
  // the read side's rule too, pinned by `commands::agents::tests::
  // case_fold_twin_keys_win_wholesale_never_merged`: one twin wins WHOLESALE.
  const firstTwin = twins[0];
  const merged: AgentOverride = { ...(firstTwin === undefined ? {} : map[firstTwin]) };
  if (cleared) {
    // ABSENT, not `undefined`-valued: `JSON.stringify` would drop an
    // `undefined`, but a `{ scout: {} }` entry WOULD serialize, and that is the
    // violation — an entry claiming to be an override while saying nothing.
    delete merged[field];
  } else {
    // Written per field rather than through a computed key: a computed
    // `{ [field]: value }` cannot be narrowed by TS (`AgentOverride[field]` is
    // the impossible `string & string[]`), and this keeps the ONLY cast on the
    // value — where the union in the signature is the thing TS cannot see
    // already matches the field.
    if (field === "tools") merged.tools = value as string[];
    else if (field === "thinking") merged.thinking = value as string;
    else merged.model = value as string;
  }
  // ADR 0067: an entry with NO fields left does not exist at all. `merged` is
  // only ever written when non-empty, and the twins are absent from `next`
  // because the loop above skipped every key in `twins`.
  if (Object.keys(merged).length > 0) next[name] = merged;
  return next;
}

/**
 * The stored entries matching no discovered definition (ADR 0023's orphans).
 * Gated by the caller on "the definitions have actually loaded": treating
 * "not loaded yet" as "nothing discovered" would flash every override as a
 * stale orphan with a live remove button.
 *
 * Matched through the ASCII fold, because the backend resolves the map's keys
 * case-insensitively — a hand-edited `"Ghost"` for a discovered `ghost` IS that
 * agent's override, and calling it stale would invite the user to delete it.
 * Returns the keys in the map's own insertion order (the render order the deleted
 * section had, and the order that keeps a test's expectation readable).
 */
export function orphanedOverrides(
  map: AgentOverrides,
  defs: readonly { name: string }[],
): string[] {
  return Object.keys(map).filter(
    (key) => !defs.some((d) => foldAscii(d.name) === foldAscii(key)),
  );
}
