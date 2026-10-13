import { describe, expect, it } from "vitest";
import { composerCommands, parseComposerCommand } from "./composerCommands";

// The grammar of a Composer command (ADR 0044): a LEADING `/` claims the
// message, the name runs to the first whitespace, and the rest is args. The
// match is EXACT — the same property ADR 0031's tag-safety rests on for a
// Mention — because a File-completion insert legitimately begins with `/`
// (`/etc/hosts`, `/home/you/notes.md`), and swallowing that prose is the one
// failure mode this grammar must never have.

describe("parseComposerCommand (the Composer-command grammar, ADR 0044)", () => {
  it("/compact with no args is the compact command with an empty arg string", () => {
    expect(parseComposerCommand("/compact")).toEqual({
      name: "compact",
      args: "",
    });
  });

  it("/compact <text> passes the trailing text as args", () => {
    expect(parseComposerCommand("/compact focus on open tasks")).toEqual({
      name: "compact",
      args: "focus on open tasks",
    });
  });

  it("a bare / is prose, not a command with an empty name", () => {
    expect(parseComposerCommand("/")).toBeNull();
  });

  it("an unmatched /name is prose (EXACT lookup, no fuzzy near-miss)", () => {
    expect(parseComposerCommand("/compct")).toBeNull();
  });

  it("/compactme is prose — the name runs to whitespace, never to a prefix match", () => {
    expect(parseComposerCommand("/compactme")).toBeNull();
  });

  it("a / that is not leading is prose (a leading / claims the message)", () => {
    expect(parseComposerCommand("try /compact now")).toBeNull();
  });

  it("a File-completion insert at position 0 is prose (the load-bearing fall-through)", () => {
    // A `?` FILE row CONSUMES its `?` and inserts the absolute path verbatim
    // (ADR 0033/0035), so this draft is a real one the picker produced. It must
    // reach the Agent byte-identically.
    expect(parseComposerCommand("/etc/hosts has two entries")).toBeNull();
  });

  it("surrounding and repeated whitespace is trimmed off both halves", () => {
    expect(parseComposerCommand("  /compact  keep tests")).toEqual({
      name: "compact",
      args: "keep tests",
    });
  });
});

describe("composerCommands (the registry the picker lists and the dispatcher matches)", () => {
  it("holds exactly one command: compact", () => {
    expect(composerCommands.map((c) => c.name)).toEqual(["compact"]);
  });

  it("every command has a description for the picker's secondary line", () => {
    for (const c of composerCommands) {
      expect(c.description.trim()).not.toBe("");
    }
  });
});
