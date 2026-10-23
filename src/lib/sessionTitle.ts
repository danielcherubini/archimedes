import type { Message } from "./sessionTypes";

/**
 * A **Session**'s label: its GENERATED **Title** (`SessionInfo.title`, written
 * once by the naming pass — ADR 0037) when it has one, else the first user
 * message truncated to ~80 chars, else the **Space**'s folder name.
 *
 * THE ONE title rule, shared by every surface that labels a Session (the
 * sidebar's rows, the close-confirm's list of open Sessions, …) — a label that
 * disagrees with the row it names is worse than no label, which is the same
 * reasoning that put the side pane's rail marks and its panel on one
 * derivation. (`SidePane`'s header and `SpacesList`'s row used to carry their
 *  own inline copies of the TITLE LOOKUP; that walk now has one owner,
 *  `sessionFieldOf` in `lib/sessionLookup.ts`, which they call from inside their
 *  selectors. The two are still separate on purpose: this function owns the
 *  LABEL (title → prompt truncation → folder name), the lookup owns WHERE the
 *  title comes from.)
 *
 * `""` is no title (the backend never writes one; a generated title is cleaned
 * to a non-empty string or not written at all).
 */
export function titleFor(
  messages: Message[] | undefined,
  spaceName: string,
  title?: string | null,
): string {
  if (title !== null && title !== undefined && title !== "") return title;
  const firstUser = messages?.find((m) => m.kind === "user");
  if (!firstUser || firstUser.text === "") return spaceName;
  return firstUser.text.length > 80 ? firstUser.text.slice(0, 80) : firstUser.text;
}
