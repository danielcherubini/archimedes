import type { Message } from "./sessionTypes";
import { recencyOf } from "./sessionRecency";

/**
 * The relative time of a **Session**'s last activity — the DISPLAY side of the
 * ONE recency rule.
 *
 * The rule itself lives in `sessionRecency.ts`'s `recencyOf`, and this function
 * DELEGATES to it: same `(sessionId, loadedMessages, recencyMap)` triple, same
 * transcript-first walk, same boot-map fallback. What `relativeTimeFor` adds is
 * only the bucketizing of that one number — `<60s` → `now`, `<60m` → `Nm`,
 * else `Nh`.
 *
 * That delegation is the whole point of this module. It used to read
 * `messages[messages.length - 1]` itself and return `null` when no transcript
 * was loaded, while `recencyOf` — the number `sortByRecency` orders the
 * **Archived** list by and the Landing session pick decides by — fell back to
 * the boot `sessionRecency` stamp for exactly that case. Two owners of "when was
 * this Session last active?" disagreed on the no-transcript arm, and the
 * user-visible symptom was a list ORDERED by a stamp its own rows refused to
 * print. One rule now decides both the number and the string, so they cannot
 * drift (the same shape of fix `sessionTitle.ts`'s Phase A applied to titles).
 *
 * The empty slot therefore changes meaning rather than disappearing: `null` now
 * means **"neither the transcript nor the boot recency map can prove recency"**
 * — reachable, not defensive, for a Session that CLOSED this boot
 * (`handleSessionClosed` appends it to `historySessions` with no boot-map entry).
 *
 * `now` stays the last parameter (defaulting to the wall clock) so a caller —
 * and a test — can pin the arithmetic to a fixed instant. The buckets are
 * byte-identical to the pre-delegation ones; only where the instant comes from
 * changed.
 */
export function relativeTimeFor(
  sessionId: string,
  loadedMessages: Message[] | undefined,
  recencyMap: Record<string, number>,
  now: number = Date.now(),
): string | null {
  const at = recencyOf(sessionId, loadedMessages, recencyMap);
  if (at === null) return null;
  const diff = now - at;
  if (diff < 60_000) return "now";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m`;
  return `${Math.floor(diff / (60 * 60_000))}h`;
}
