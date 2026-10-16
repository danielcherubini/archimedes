import type { Message } from "../store/sessions";

/**
 * "When was this session last active?" — the one answer the session list
 * sorts by, and the answer the ROW already prints (`SpacesList`'s relative
 * time is the same last message).
 *
 * A session's last activity is its transcript's LAST message stamp. That is
 * deliberately the transcript and not a new column: the transcript is what the
 * row's time reads, so the ORDER and the LABEL can never disagree — a session
 * showing `2m` is the session that sorts as active 2m ago. `SessionInfo` over
 * IPC has no `createdAt`/`lastActiveAt` field, so the loaded transcript is the
 * only recency the frontend holds; a session not opened since boot has NO
 * transcript loaded and therefore no known activity (`null`), which is why
 * `sortByActivity` sinks the unknowns rather than inventing `0` for them.
 */
export function lastActivityOf(
  messages: Message[] | undefined,
): number | null {
  const last = messages?.[messages.length - 1];
  return last ? last.at : null;
}

/** How a session with NO known activity is placed (see below). */
export type UnknownPlacement = "first" | "last";

/**
 * Most-recently-active first. Two rules make this a list a user can read
 * rather than a list that shuffles:
 *
 * - `unknowns` decides where a session with NO evidence goes, because "no
 *   transcript loaded" means two OPPOSITE things in the sidebar's two groups:
 *   `first` for the LIVE group (a live session with an empty transcript is one
 *   that was just started — the newest activity there), `last` for the STORED
 *   group (a session not opened since boot has no evidence, and evidence-free
 *   must not outrank evidence). Among the unknowns the INPUT order survives in
 *   both cases — the caller's order is already meaningful (live insertion
 *   order, or the server's recency order).
 * - STABLE for ties: `Array.sort` is stable in every engine we ship on, so
 *   equal stamps keep the input order instead of trading places on each render.
 *   A list that re-orders rows under a steady cursor is worse than a list
 *   sorted by a weaker key.
 *
 * The input array is not mutated (callers keep their own order — `reverse()`
 * on a store-derived array would corrupt it).
 */
export function sortByActivity(
  ids: readonly string[],
  activity: Record<string, number | null>,
  unknowns: UnknownPlacement = "first",
): string[] {
  // The unknowns get the sentinel that sorts to the wanted end of a DESCENDING
  // comparison: `Infinity` sorts first, `-Infinity` last. Two unknowns then
  // subtract to `NaN`, and `NaN ||` is falsy, so the tie falls through to input
  // order — which is exactly what "keep the caller's order among the unknowns"
  // asks for.
  const sentinel = unknowns === "first" ? Infinity : -Infinity;
  return ids
    .map((id, i) => ({ id, i, at: activity[id] ?? sentinel }))
    .sort((a, b) => b.at - a.at || a.i - b.i)
    .map((x) => x.id);
}

/**
 * The SUBSCRIPTION KEY for a list of sessions' activity, and its inverse
 * `activityFromKey`. It exists so the session list can subscribe to last
 * activity WITHOUT re-rendering on every streamed token.
 *
 * A selector that returned the `messages` map (or a fresh object of stamps)
 * would re-render the whole list on every chunk, because streaming replaces
 * the trailing message object to grow its text — `applySessionUpdate`'s
 * same-`messageId` append keeps the message's `at` and its slot in the array,
 * so the ACTIVITY has not moved while the array identity has. This key is a
 * primitive that moves only when activity moves: a new message (length) or a
 * re-stamped tail (stamp). Same rule as `useSessionStatuses`: subscribe to
 * something STABLE (here a primitive string, never a fresh object) or Zustand
 * re-renders forever.
 *
 * WHY THE KEY CARRIES THE DATA RATHER THAN THE CONSUMER RE-READING IT: the
 * consumer would need the `messages` map to recompute the stamps, and reading
 * it is exactly the subscription this key exists to avoid. So the key is
 * parseable — one `activityKeyOf`/`activityFromKey` pair, so the writer and the
 * reader cannot disagree about the encoding, and the pair is tested by a
 * round-trip.
 *
 * The key names the ids it covers, so a list that grows (a new session) or
 * re-orders is a different key. The id is read back as everything before the
 * LAST TWO separators, so an id containing `:` still round-trips; an id
 * containing the `|` RECORD separator would not, which is a documented limit
 * rather than a bug — ids are Rust-side `uuid::Uuid::new_v4()` values.
 */
export function activityKeyOf(
  ids: readonly string[],
  messages: Record<string, Message[] | undefined>,
): string {
  return ids
    .map((id) => {
      const rows = messages[id];
      const at = lastActivityOf(rows);
      return `${id}:${rows?.length ?? -1}:${at ?? ""}`;
    })
    .join("|");
}

/** The map `activityKeyOf` encoded. An id with no loaded transcript is `null`. */
export function activityFromKey(
  key: string,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (key === "") return out;
  for (const segment of key.split("|")) {
    const tail = segment.lastIndexOf(":");
    const mid = segment.lastIndexOf(":", tail - 1);
    if (mid < 0) continue; // not one of ours — treat as no data.
    const id = segment.slice(0, mid);
    const stamp = segment.slice(tail + 1);
    out[id] = stamp === "" ? null : Number(stamp);
  }
  return out;
}
