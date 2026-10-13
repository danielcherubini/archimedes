import type { Message } from "../store/sessions";

/**
 * A **Session**'s label: its GENERATED **Title** (`SessionInfo.title`, written
 * once by the naming pass — ADR 0037) when it has one, else the first user
 * message truncated to ~80 chars, else the **Space**'s folder name.
 *
 * THE ONE title rule, shared by every surface that labels a Session (the
 * sidebar's rows, the close-confirm's list of open Sessions, …) — a label that
 * disagrees with the row it names is worse than no label, which is the same
 * reasoning that put the side pane's rail marks and its panel on one
 * derivation. (`SidePane`'s header still carries its own inline copy, reading
 * the title from all three session arrays; folding it in here is a separate
 * change, not one to slip in beside a tab bar's ✕.)
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
