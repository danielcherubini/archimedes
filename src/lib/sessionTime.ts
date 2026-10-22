import type { Message } from "../store/sessions";

/**
 * The relative time of a **Session**'s last activity — the ONE rule, previously
 * duplicated verbatim in `SpacesList` and `settings/SessionsSection`.
 *
 * Derived ONLY from the latest message's `at` when the transcript is loaded this
 * boot (`useSessions.messages[sessionId]`): `<60s` → `now`, `<60m` → `Nm`,
 * else `Nh`. It returns `null` when no transcript is loaded, and that is the
 * load-bearing part of the contract: `SessionInfo` has NO `createdAt` (the
 * store's ordering note says so explicitly), so a stored session that was never
 * opened this boot has no loaded messages → `null`, and the row renders an empty
 * slot rather than inventing a time.
 *
 * `now` is a parameter (defaulting to the wall clock) so a caller — and a test —
 * can pin the arithmetic to a fixed instant.
 */
export function relativeTimeFor(
  messages: Message[] | undefined,
  now: number = Date.now(),
): string | null {
  const latest = messages?.[messages.length - 1];
  if (!latest) return null;
  const diff = now - latest.at;
  if (diff < 60_000) return "now";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m`;
  return `${Math.floor(diff / (60 * 60_000))}h`;
}
