import type { Message } from "./sessionTypes";

/**
 * "When was this **Session** last active?" — the ONE answer, in the frontend.
 *
 * It lives beside `sessionTitle.ts`'s `titleFor` for the same reason that
 * module exists: one function, so two surfaces cannot disagree. ADR 0075 took
 * list position away as evidence of recency, so every surface that wants
 * recency has to ask THIS question — the sidebar's Landing Session, the
 * close-reason banner, the **Archived** section's sort. A second copy is a
 * second owner of the rule, which is how the first copy got it wrong.
 *
 * This is the successor of `sessionActivity.ts`'s `lastActivityOf` (which T04
 * deletes). It deliberately does NOT re-export that name, or any equivalent of
 * it: a call site must not be able to pick a side between two spellings of the
 * same walk. The transcript read below IS the move.
 *
 * It imports no store (`sessionTitle.ts` / `sessionTypes.ts` are the
 * precedent — a `lib → store` edge is the cycle `sessionTypes.ts`'s header
 * documents). `sortByManualOrder` lives here rather than beside the store's
 * `mergeSessionOrder` because "the thing I cannot place goes at the bottom" is
 * the SAME rule as the recency sink below, and a reader can only compare the
 * two lines if they are two lines apart.
 */

/** What a recency decision may read. `messages` is OPTIONAL: a component that
 *  subscribed to the whole `messages` map would re-render on every streamed
 *  token (the exact hazard `activityKeyOf` exists to dodge), so a call site
 *  passes the transcript arm only when it already holds it cheaply, and the
 *  boot recency map carries the decision otherwise. */
export interface RecencyEvidence {
  /** Boot recency per session id, from `sessionRecency()` (ADR 0075). */
  recency: Record<string, number>;
  /** Transcripts loaded this boot — the FRESHER evidence, when this call site has it. */
  messages?: Record<string, Message[] | undefined>;
}

/** "When was this Session last active?" — the one answer, in Unix ms, or `null`. */
export function recencyOf(
  sessionId: string,
  loadedMessages: Message[] | undefined,
  recencyMap: Record<string, number>,
): number | null {
  const last = loadedMessages?.[loadedMessages.length - 1];
  if (last !== undefined) return last.at;
  return recencyMap[sessionId] ?? null;
}

/** Most-recent-first over ids. STABLE for ties (input order survives), and an id
 *  with no evidence goes LAST — never `0`, which would be inventing recency. */
export function sortByRecency(
  ids: readonly string[],
  evidence: RecencyEvidence,
): string[] {
  return ids
    .map((id, i) => ({ id, i, at: recencyOf(id, evidence.messages?.[id], evidence.recency) }))
    // Two unknowns are `-Infinity - -Infinity` → NaN → falsy, so the tie falls
    // through to input order. Same mechanism `sortByActivity` documented.
    .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity) || a.i - b.i)
    .map((x) => x.id);
}

/** The id a recency decision lands on, or `null`. The ONLY comparison a call site may use. */
export function mostRecentByRecency(
  ids: readonly string[],
  evidence: RecencyEvidence,
): string | null {
  return sortByRecency(ids, evidence)[0] ?? null;
}

/** Ascending by the stored order number (the database reads it `ASC`, and new
 *  rows take `MAX + 1`, so a BIGGER number is a LOWER row). An id the map does
 *  not know goes LAST — never `0`, which would promote a row started this boot
 *  to the top of a list the user arranged. STABLE for ties and among unknowns
 *  (input order survives), for the same reason `sortByRecency` is. */
export function sortByManualOrder(
  ids: readonly string[],
  orderMap: Record<string, number>,
): string[] {
  return ids
    .map((id, i) => ({ id, i, at: orderMap[id] }))
    // `?? Infinity` sinks the unknowns to the BOTTOM of an ASCENDING sort (the
    // mirror of `sortByRecency`'s `-Infinity`, which sinks them in a DESCENDING
    // one). Two unknowns are `Infinity - Infinity` → NaN → falsy, so their tie
    // falls through to input order — the same mechanism `sortByActivity` documented.
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.i - b.i)
    .map((x) => x.id);
}
