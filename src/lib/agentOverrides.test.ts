import { describe, expect, it } from "vitest";
import type { AgentOverrides } from "../lib/tauri";
import {
  foldAscii,
  orphanedOverrides,
  withOverride,
} from "./agentOverrides";

/**
 * The shared editor's RULES live here, tested directly, because two of them
 * were pinned by tests in the DELETED `SettingsPage.test.tsx` (the file that
 * drove `SubagentSection`) and both are the kind a hand-rolled
 * `{ ...map, [name]: { ...entry, [field]: value } }` spread gets wrong:
 *
 *  - the ASCII-case-fold TWIN drop (a `"Scout"` left alongside `"scout"` makes
 *    the backend's case-insensitive `.find` pick between them in nondeterministic
 *    HashMap iteration order), and
 *  - the DELETE-THE-EMPTY-ENTRY rule (ADR 0067: an entry with no fields must not
 *    survive as `{}`, because absence is the only meaning of "does not speak").
 *
 * The modal re-covers both through the UI; this file is what stops them drifting
 * if a second surface ever appears.
 */
describe("agentOverrides.withOverride", () => {
  it("sets_one_field_and_leaves_every_other_entry_untouched", () => {
    const map: AgentOverrides = { scout: { thinking: "high" }, plan: {} };
    const next = withOverride(map, "ghost", "model", "tama/Qwen3.8");
    expect(next).toEqual({
      scout: { thinking: "high" },
      plan: {},
      ghost: { model: "tama/Qwen3.8" },
    });
    // IMMUTABLE: the input map is not mutated (the React state would not move,
    // and the caller's read-modify-write would be a side effect).
    expect(map.ghost).toBeUndefined();
  });

  it("sets_a_tools_array", () => {
    const next = withOverride({}, "scout", "tools", ["read_file", "grep"]);
    expect(next).toEqual({ scout: { tools: ["read_file", "grep"] } });
  });

  it("an_undefined_value_deletes_the_field_and_leaves_the_siblings", () => {
    const map: AgentOverrides = { scout: { model: "p/m", thinking: "high" } };
    const next = withOverride(map, "scout", "model", undefined);
    expect(next).toEqual({ scout: { thinking: "high" } });
    // ABSENT, not `null` and not `undefined`-valued (ADR 0067 — `null` on the
    // wire is a value the resolver has no reading for).
    expect("model" in (next.scout ?? {})).toBe(false);
  });

  it("an_empty_tools_array_is_treated_as_absent", () => {
    // ADR 0067: `tools: []` contributes NOTHING, so unticking every tool writes
    // no key at all rather than an empty list. The row reads "Inherits parent
    // tools" and the wire carries no `tools`.
    const map: AgentOverrides = { scout: { model: "p/m", tools: ["read"] } };
    const next = withOverride(map, "scout", "tools", []);
    expect(next).toEqual({ scout: { model: "p/m" } });
    expect("tools" in next.scout).toBe(false);
  });

  it("clearing_the_last_field_deletes_the_whole_entry", () => {
    // ADR 0067 again, one level up: an entry of `{}` still EXISTS as a key, which
    // makes the agent look overridden to anything that only asks "is there an
    // entry?" — and it is an entry the UI can never render a control for.
    const map: AgentOverrides = { scout: { model: "p/m" } };
    const next = withOverride(map, "scout", "model", undefined);
    expect(next).toEqual({});
    expect("scout" in next).toBe(false);
  });

  it("drops_every_ascii_case_fold_twin_of_the_key_on_write", () => {
    // The backend folds ASCII A–Z only, so `"Scout"` and `"SCOUT"` both address
    // `scout`. Writing must leave EXACTLY ONE key — the canonical name.
    const map: AgentOverrides = {
      Scout: { model: "gone/m1" },
      SCOUT: { thinking: "low" },
      plan: { model: "p/m" },
    };
    const next = withOverride(map, "scout", "model", "openai/GPT-5");
    expect(Object.keys(next).sort()).toEqual(["plan", "scout"]);
    expect(next.scout).toEqual({ model: "openai/GPT-5" });
  });

  it("drops_a_twin_even_when_the_write_clears_the_field", () => {
    // Clearing `scout`'s model must also clear the twin away — leaving `"Scout"`
    // behind would mean "clear this override" did not clear it.
    const map: AgentOverrides = { Scout: { model: "p/m" }, scout: { model: "p/m" } };
    const next = withOverride(map, "scout", "model", undefined);
    expect(next).toEqual({});
  });

  it("a_non_ascii_case_twin_is_NOT_folded_away", () => {
    // The pair the deleted Settings file pinned from the other side: the backend
    // ignores non-ASCII case pairs, so folding them here would DELETE a key the
    // backend never matched — a silent data loss the fold must not cause.
    // `É` (U+00C9) / `é` (U+00E9) are written as ESCAPES, not literals: a source
    // file saved with the decomposed form (`E` + U+0301) would make a literal
    // comparison here depend on the editor.
    const upper = "\u00C9-claude";
    const map: AgentOverrides = { [upper]: { model: "p/m" } };
    const next = withOverride(map, "\u00E9-claude", "model", "p/m2");
    expect(Object.keys(next).sort()).toEqual([upper, "\u00E9-claude"].sort());
    expect(next[upper]).toEqual({ model: "p/m" });
  });
});

describe("agentOverrides.foldAscii", () => {
  it("folds_ASCII_A_to_Z_and_nothing_else", () => {
    expect(foldAscii("Scout")).toBe("scout");
    expect(foldAscii("SCOUT")).toBe("scout");
    // A Unicode `toLowerCase()` WOULD fold these pairs — the backend's
    // `eq_ignore_ascii_case` does not, so the fold must not either.
    expect(foldAscii("É-claude")).toBe("É-claude");
    expect(foldAscii("İ")).toBe("İ");
  });
});

describe("agentOverrides.orphanedOverrides", () => {
  const defs = [{ name: "scout" }, { name: "ghost" }];

  it("lists_the_stored_keys_matching_no_definition", () => {
    const map: AgentOverrides = { scout: { model: "p/m" }, ghost: {}, nope: {} };
    expect(orphanedOverrides(map, defs)).toEqual(["nope"]);
  });

  it("a_case_variant_key_is_not_an_orphan", () => {
    // `"Ghost"` beside a discovered `ghost` IS that agent's stored override (the
    // backend matches case-insensitively), so calling it stale would invite the
    // user to delete a live override.
    expect(orphanedOverrides({ Ghost: { model: "p/m" } }, defs)).toEqual([]);
  });

  it("a_non_ascii_case_variant_key_IS_an_orphan", () => {
    // The mirror of the rule above: `"É-claude"` matches no definition under the
    // ASCII-only fold — exactly as it matches nothing at dispatch — so it is
    // reported, with the remove button as its only cleanup path.
    expect(orphanedOverrides({ "É-claude": {} }, [{ name: "é-claude" }])).toEqual([
      "É-claude",
    ]);
  });

  it("an_empty_definition_list_reports_every_key", () => {
    // The CALLER owns the "have the definitions loaded?" gate (this helper cannot
    // tell "nothing discovered" from "not asked yet"); pinned so the gate is
    // visible as the helper's contract, not an oversight.
    expect(orphanedOverrides({ scout: { model: "p/m" } }, [])).toEqual(["scout"]);
  });
});
