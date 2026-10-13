/**
 * A **Composer command** — a `/name` the Client intercepts on send (ADR 0044).
 *
 * It is NOT a **Mention** (`$`/`@`/`#`, which EXPAND into a block on send,
 * ADR 0031) and NOT **File completion** (`?`, which inserts a PATH and expands
 * nothing, ADR 0033). A command is CONSUMED: no user row, no prompt, no model
 * call. The picker is shared with all three (one floating list, one token scan);
 * the meaning is not — which is why this registry is a separate module rather
 * than another field on the mention catalogs.
 */
export interface ComposerCommand {
  /** The name typed after the `/` — matched EXACTLY, never by prefix. */
  name: string;
  /** One line for the picker's secondary line. */
  description: string;
}

/**
 * The commands the Client knows. Deliberately ONE entry: `/help`, fuzzy
 * matching and arg autocomplete were considered and rejected (ADR 0044), and a
 * second command is the change that re-opens this decision, not this one.
 */
export const composerCommands: ComposerCommand[] = [
  { name: "compact", description: "Summarize the older context now" },
];

/** A claimed message: the command's `name` plus whatever the user typed after it. */
export interface ParsedCommand {
  name: string;
  /** The text after the name, trimmed — `""` when the command stood alone. */
  args: string;
}

/**
 * Parse a draft as a **Composer command** (ADR 0044). `null` means "send it as
 * prose", and that fall-through is LOAD-BEARING, not courtesy: a **File
 * completion** file row consumes its `?` and inserts the absolute path verbatim
 * (ADR 0033/0035), so a draft can legitimately BEGIN `/etc/hosts ` or
 * `/home/you/notes.md `. A namespace that claims a leading `/` therefore has to
 * give back anything it does not recognize, BYTE-IDENTICALLY.
 *
 * The rules, each of which is pinned in `composerCommands.test.ts`:
 *  - the draft is `trim`ed first, and must then START with `/` (pi's rule: a
 *    leading `/` claims the message — `try /compact now` is prose);
 *  - the name is the run up to the FIRST whitespace, minus the `/`;
 *  - the args are everything after it, `trim`med;
 *  - the lookup is EXACT, so `/compactme` is prose rather than a near-miss —
 *    the same property ADR 0031's tag-safety rests on for a Mention. A bare
 *    `/` names nothing, so it is prose too.
 */
export function parseComposerCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const space = trimmed.search(/\s/);
  const name = (space === -1 ? trimmed : trimmed.slice(0, space)).slice(1);
  if (name === "") return null;
  const command = composerCommands.find((c) => c.name === name);
  if (!command) return null;
  return { name: command.name, args: space === -1 ? "" : trimmed.slice(space).trim() };
}
