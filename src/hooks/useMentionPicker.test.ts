import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useRef, useState } from "react";
import {
  type AgentDefinitionDto,
  type CompletionDirDto,
  type CompletionEntryDto,
  type ListingDto,
  type McpServerInfo,
  type SkillInfo,
} from "../lib/tauri";
import { IPC_EVENTS } from "../lib/ipc/events";
import { useMentionPicker, type MentionPickerState } from "./useMentionPicker";

/**
 * `useMentionPicker` — cluster C of the composer's picker (Phase D / Task D4),
 * asserted directly with `renderHook`.
 *
 * WHAT THIS FILE OWNS and what it deliberately does not. The component-level
 * proof stays in `ChatStream.test.tsx`, which drives the real textarea and is
 * the ONLY place two things can be proven: the `dirPrefix` CACHE KEY (with
 * `dirPrefix` as an argument, a hook can only show "same input, same output" —
 * which is exactly why the derivation stayed in `ChatStream`), and the
 * caret/keyboard half that `ComposerRow`'s `onKeyDown` owns. What this file can
 * own is the derivation machine: which catalog the active prefix reads, how
 * each side filters, the two `?` caps and their notes, the stale-token guard,
 * the derived `activeIndex`, and `selectMention`'s three insertion policies.
 *
 * The harness is thin on purpose. `draft`/`setDraft` belong to the caller (the
 * hook never owns the draft — eleven sites write it) and `composerRef` is a
 * real `<textarea>`, because the caret is an input to two of the derivations.
 * The `picker` state is seeded through the hook's OWN `setPicker`, so nothing
 * here reaches into internals.
 */

// --- fixtures ---------------------------------------------------------------

function skill(name: string): SkillInfo {
  return {
    name,
    description: `${name} description`,
    path: `/p/.agents/skills/${name}/SKILL.md`,
    dir: `/p/.agents/skills/${name}`,
    scope: "space",
    body: "B",
    disableModelInvocation: false,
    shadowed: [],
  };
}

function agent(name: string): AgentDefinitionDto {
  return { name, description: `${name} agent`, model: null, scope: "space" };
}

function mcp(name: string): McpServerInfo {
  return { name, kind: "stdio", summary: `npx -y ${name}` };
}

function listing(entries: string[], truncated = false): ListingDto {
  return { entries, truncated };
}

function dirEntry(
  name: string,
  opts: { insert?: string; display?: string; isDir?: boolean } = {},
): CompletionEntryDto {
  return {
    name,
    insert: opts.insert ?? `/home/u/.config/${name}`,
    display: opts.display ?? `~/.config/${name}`,
    isDir: opts.isDir ?? false,
  };
}

function dir(entries: CompletionEntryDto[], truncated = false): CompletionDirDto {
  return { entries, truncated };
}

const SKILLS = [skill("alpha-skill"), skill("beta-tool"), skill("gamma")];
const AGENTS = [agent("alpha-agent"), agent("reviewer")];
const MCP = [mcp("postgres"), mcp("redis")];

// --- the harness ------------------------------------------------------------

interface HarnessProps {
  draft: string;
  /** The active picker token. In the app the textarea's `onChange` owns it;
   * here it is seeded through the hook's own `setPicker`. */
  picker: { prefix: "$" | "@" | "#" | "?" | "/"; query: string; index: number } | null;
  skills: SkillInfo[];
  agents: AgentDefinitionDto[];
  mcpServers: McpServerInfo[];
  files: ListingDto;
  completion: CompletionDirDto;
  mcpMentionsEnabled: boolean;
}

type Seed = Partial<HarnessProps>;

function mount(seed: Seed = {}) {
  const props: HarnessProps = {
    draft: seed.draft ?? "",
    picker: seed.picker ?? null,
    skills: seed.skills ?? SKILLS,
    agents: seed.agents ?? AGENTS,
    mcpServers: seed.mcpServers ?? MCP,
    files: seed.files ?? listing([]),
    completion: seed.completion ?? dir([]),
    mcpMentionsEnabled: seed.mcpMentionsEnabled ?? false,
  };
  // A REAL textarea: `selectMention` and the insert-skill handler both read the
  // caret, and jsdom stores it faithfully. It is the CONTROLLED input, so its
  // value tracks the draft exactly as `ComposerRow`'s `value={draft}` does —
  // which is what makes the caret assertions below honest (an out-of-date
  // `value` would reset the selection).
  const textarea = document.createElement("textarea");
  textarea.value = props.draft;
  document.body.appendChild(textarea);

  const harness = renderHook(
    (p: HarnessProps) => {
      const [draft, setDraft] = useState(p.draft);
      const draftRef = useRef(draft);
      draftRef.current = draft;
      // The caller declares the picker cell, exactly as `ChatStream` does: the
      // `dirPrefix` the completion fetch is keyed on is a pure function of this
      // state, so the cell cannot live inside the hook (its header records the
      // cycle in full).
      const [picker, setPicker] = useState<MentionPickerState | null>(p.picker);
      const composerRef = useRef<HTMLTextAreaElement | null>(textarea);
      const pickerApi = useMentionPicker({
        draft,
        setDraft,
        draftRef,
        composerRef,
        picker,
        setPicker,
        skills: p.skills,
        agents: p.agents,
        mcpServers: p.mcpServers,
        files: p.files,
        completion: p.completion,
        mcpMentionsEnabled: p.mcpMentionsEnabled,
      });
      // The harness's one job beyond wiring: keep the textarea's value in step
      // with the draft, which is what `ComposerRow`'s `value={draft}` does. It
      // runs in an EFFECT so it lands BEFORE the hook's `requestAnimationFrame`
      // caret restore — the same order React commits and then the frame runs.
      useEffect(() => {
        textarea.value = draft;
      }, [draft]);
      // `setDraft` is exposed because the caller owns it: a test that wants the
      // draft to move WITHOUT the picker (to prove the effect reads the LIVE
      // mirror) needs the same setter the component holds.
      return { ...pickerApi, draft, setDraft, textarea: composerRef.current };
    },
    { initialProps: props },
  );

  /** Put the caret at `pos`. The controlled value is re-synced by the harness's
   * own effect (above), so this only moves the caret. */
  const setCaret = (pos: number) => {
    act(() => {
      textarea.setSelectionRange(pos, pos);
    });
  };

  return {
    result: harness.result,
    unmount: harness.unmount,
    textarea,
    setCaret,
    cleanup: () => textarea.remove(),
  };
}

beforeEach(() => {
  // jsdom's `requestAnimationFrame` is not guaranteed to run inside `act`, and
  // two behaviours here end in one (the re-focus/caret restore). Making it a
  // timer makes it observable with one `await`.
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) =>
    window.setTimeout(() => cb(performance.now()), 0),
  );
});

const flushFrames = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

// --- the picker state cell --------------------------------------------------

describe("useMentionPicker — the picker state cell", () => {
  it("starts closed", () => {
    const h = mount();
    expect(h.result.current.picker).toBeNull();
    expect(h.result.current.activeIndex).toBe(0);
    h.cleanup();
  });

  it("setPicker opens it and setPicker(null) closes it", () => {
    const h = mount({ draft: "$al" });
    act(() => h.result.current.setPicker({ prefix: "$", query: "al", index: 0 }));
    expect(h.result.current.picker).toEqual({ prefix: "$", query: "al", index: 0 });
    act(() => h.result.current.setPicker(null));
    expect(h.result.current.picker).toBeNull();
    h.cleanup();
  });
});

// --- which catalog the active prefix reads ---------------------------------

describe("useMentionPicker — one picker, filtered to the ACTIVE prefix's catalog", () => {
  it("`$` lists the skills on a case-INSENSITIVE NAME SUBSTRING (never the description)", () => {
    const h = mount({ draft: "$ALP", picker: { prefix: "$", query: "ALP", index: 0 } });
    expect(h.result.current.filtered.map((r) => r.name)).toEqual(["alpha-skill"]);
    expect(h.result.current.filtered[0]!.description).toBe("alpha-skill description");
    // A query that matches no NAME but matches a DESCRIPTION yields nothing —
    // the filter is name-only (v1), not "search the row".
    h.cleanup();

    const desc = mount({
      draft: "$description",
      picker: { prefix: "$", query: "description", index: 0 },
    });
    expect(desc.result.current.filtered).toEqual([]);
    desc.cleanup();
  });

  it("`@` lists the agents", () => {
    const h = mount({ draft: "@AL", picker: { prefix: "@", query: "AL", index: 0 } });
    expect(h.result.current.filtered.map((r) => [r.name, r.description])).toEqual([
      ["alpha-agent", "alpha-agent agent"],
    ]);
    h.cleanup();
  });

  it("`#` yields NO rows while the MCP trigger is off, and the server's `summary` when it is on", () => {
    // The `#` gate IS the catalog: an empty MCP catalog means no rows, so the
    // picker renders nothing and no keyboard branch intercepts a key — Enter
    // still sends.
    const off = mount({
      draft: "#pos",
      picker: { prefix: "#", query: "pos", index: 0 },
      mcpMentionsEnabled: false,
    });
    expect(off.result.current.filtered).toEqual([]);
    off.cleanup();

    const on = mount({
      draft: "#pos",
      picker: { prefix: "#", query: "pos", index: 0 },
      mcpMentionsEnabled: true,
    });
    expect(on.result.current.filtered.map((r) => [r.name, r.description])).toEqual([
      ["postgres", "npx -y postgres"],
    ]);
    on.cleanup();
  });

  it("`/` lists the Composer commands on an EXACT case-sensitive startsWith", () => {
    const hit = mount({
      draft: "/comp",
      picker: { prefix: "/", query: "comp", index: 0 },
    });
    expect(hit.result.current.filtered.map((r) => r.name)).toEqual(["compact"]);
    // The `/` ON THE KEY keeps a command from colliding with a same-named skill.
    expect(hit.result.current.filtered[0]!.key).toBe("/compact");
    hit.cleanup();

    // UPPERCASE forms NO row: the dispatcher refuses to run `/COMPACT`, so a row
    // here would be a lie — which is why the filter is `startsWith` on the RAW
    // query and never the fuzzy match the Mention branch ends in.
    const miss = mount({
      draft: "/COMP",
      picker: { prefix: "/", query: "COMP", index: 0 },
    });
    expect(miss.result.current.filtered).toEqual([]);
    miss.cleanup();
  });

  it("a closed picker yields the FULL skill list and no note (the render gate is `open`)", () => {
    const h = mount({ draft: "", picker: null });
    // `picker?.query ?? ""` — harmless, because `open` IS the `picker` state.
    expect(h.result.current.filtered.map((r) => r.name)).toEqual([
      "alpha-skill",
      "beta-tool",
      "gamma",
    ]);
    expect(h.result.current.note).toBeUndefined();
    h.cleanup();
  });
});

// --- the `?` side -----------------------------------------------------------

describe("useMentionPicker — `?` File completion (ADR 0033) and Directory completion (ADR 0035)", () => {
  it("a RELATIVE `?` query filters the Space Listing with `fuzzyMatch` (a SUBSEQUENCE)", () => {
    const h = mount({
      draft: "?src/comp/Form",
      picker: { prefix: "?", query: "src/comp/Form", index: 0 },
      files: listing(["src/components/Formula.tsx", "README.md"]),
    });
    expect(h.result.current.filtered.map((r) => r.name)).toEqual([
      "src/components/Formula.tsx",
    ]);
    // A Space row shows the Space-RELATIVE path, carries NO description (ONE
    // line), and keys on the trigger + path.
    expect(h.result.current.filtered[0]!.description).toBe("");
    expect(h.result.current.filtered[0]!.key).toBe("?src/components/Formula.tsx");
    expect(h.result.current.filtered[0]!.label).toBeUndefined();
    h.cleanup();
  });

  it("a relative `?` token NEVER reads the Directory completion rows (the arm order is load-bearing)", () => {
    const h = mount({
      draft: "?README",
      picker: { prefix: "?", query: "README", index: 0 },
      files: listing(["README.md"]),
      // Rows that WOULD render if the completion arm were moved first — it would
      // then swallow every `?` token and a relative query would stop offering
      // Space Listing rows.
      completion: dir([dirEntry("README.md", { insert: "/home/u/README.md" })]),
    });
    expect(h.result.current.filtered.map((r) => r.name)).toEqual(["README.md"]);
    h.cleanup();
  });

  it("an OUT-OF-SPACE `?` token shows the abbreviated `~/…` and INSERTS the absolute path", () => {
    const h = mount({
      draft: "?~/.config/ht",
      picker: { prefix: "?", query: "~/.config/ht", index: 0 },
      // The Space Listing is NOT consulted outside the Space.
      files: listing(["htop-not-the-space-file"]),
      completion: dir([dirEntry("htop", { insert: "/home/u/.config/htop" })]),
    });
    const row = h.result.current.filtered[0]!;
    // `name` is what gets inserted; `label` is what the row shows.
    expect(row.name).toBe("/home/u/.config/htop");
    expect(row.label).toBe("~/.config/htop");
    expect(row.isDir).toBe(false);
    h.cleanup();
  });

  it("the outside rows are filtered on the entry's OWN name, and directories sort FIRST", () => {
    const h = mount({
      draft: "?~/.config/eu",
      picker: { prefix: "?", query: "~/.config/eu", index: 0 },
      completion: dir([
        // `htop`'s PATH contains `e`…`u`, its NAME does not: filtering the
        // absolute `insert` would offer this row (a path is a strict superset of
        // its own basename).
        dirEntry("htop", { insert: "/home/u/.config/htop" }),
        dirEntry("menu.conf", { insert: "/home/u/.config/menu.conf" }),
        dirEntry("eu-dir", { insert: "/home/u/.config/eu-dir", isDir: true }),
      ]),
    });
    expect(h.result.current.filtered.map((r) => r.name)).toEqual([
      "/home/u/.config/eu-dir",
      "/home/u/.config/menu.conf",
    ]);
    // The directory row is marked, so `selectMention` descends instead of
    // consuming the trigger.
    expect(h.result.current.filtered[0]!.isDir).toBe(true);
    h.cleanup();
  });

  it("a relative `?` query caps at 10 RENDERED rows while the note counts the UNBOUNDED matches", () => {
    const many = Array.from({ length: 150 }, (_, i) => `src/f${i}.rs`);
    const h = mount({
      draft: "?src/f",
      picker: { prefix: "?", query: "src/f", index: 0 },
      files: listing(many),
    });
    expect(h.result.current.filtered).toHaveLength(10);
    // The cap note exists BECAUSE the count is unbounded — returning the bounded
    // length here would silently kill it.
    expect(h.result.current.note).toBe(
      "Too many matches — keep typing to narrow the list",
    );
    h.cleanup();
  });

  it("the three Mention prefixes are UNCAPPED", () => {
    const many = Array.from({ length: 40 }, (_, i) => skill(`skill-${i}`));
    const h = mount({
      draft: "$skill",
      picker: { prefix: "$", query: "skill", index: 0 },
      skills: many,
    });
    expect(h.result.current.filtered).toHaveLength(40);
    expect(h.result.current.note).toBeUndefined();
    h.cleanup();
  });
});

// --- the note ---------------------------------------------------------------

describe("useMentionPicker — the picker's one explanation line", () => {
  it("states 'too many matches' when the render cap trimmed something", () => {
    const many = Array.from({ length: 150 }, (_, i) => `src/f${i}.rs`);
    const h = mount({
      draft: "?src/f",
      picker: { prefix: "?", query: "src/f", index: 0 },
      files: listing(many),
    });
    expect(h.result.current.note).toBe(
      "Too many matches — keep typing to narrow the list",
    );
    h.cleanup();
  });

  it("states 'listing capped' when the LISTING was truncated and the query matched few", () => {
    const h = mount({
      draft: "?REA",
      picker: { prefix: "?", query: "REA", index: 0 },
      files: listing(["README.md"], true),
    });
    expect(h.result.current.note).toBe(
      "Listing capped — some files may be missing",
    );
    h.cleanup();
  });

  it("'too many matches' SHADOWS 'listing capped' when both hold", () => {
    const many = Array.from({ length: 150 }, (_, i) => `src/f${i}.rs`);
    const h = mount({
      draft: "?src/f",
      picker: { prefix: "?", query: "src/f", index: 0 },
      files: listing(many, true),
    });
    // The render cap is what the user is hitting NOW and "keep typing" is
    // actionable for it; the walk cap is invisible below it.
    expect(h.result.current.note).toBe(
      "Too many matches — keep typing to narrow the list",
    );
    h.cleanup();
  });

  it("reads the DIRECTORY's truncation when the token is outside, not the Space's", () => {
    // The Space is capped, the directory is not — and the directory is what is
    // on screen, so a Space-cap note would be a true statement about a listing
    // the user is not looking at.
    const outside = mount({
      draft: "?~/.config/ht",
      picker: { prefix: "?", query: "~/.config/ht", index: 0 },
      files: listing([], true),
      completion: dir([dirEntry("htop", { isDir: true })], false),
    });
    expect(outside.result.current.note).toBeUndefined();
    outside.cleanup();

    const capped = mount({
      draft: "?~/.config/ht",
      picker: { prefix: "?", query: "~/.config/ht", index: 0 },
      files: listing([], false),
      completion: dir([dirEntry("htop", { isDir: true })], true),
    });
    expect(capped.result.current.note).toBe(
      "Listing capped — some files may be missing",
    );
    capped.cleanup();
  });

  it("the Mention prefixes are note-free", () => {
    const h = mount({
      draft: "$alpha",
      picker: { prefix: "$", query: "alpha", index: 0 },
    });
    expect(h.result.current.note).toBeUndefined();
    h.cleanup();
  });
});

// --- the stale-token guard --------------------------------------------------

describe("useMentionPicker — the stale-token guard", () => {
  it("renders NO rows and NO note once the draft no longer carries the token", () => {
    // The case that matters: `send()` clears the draft but NEVER clears the
    // picker, so without this guard the picker visually RESURRECTS over an
    // emptied composer (and a catalog that lands afterwards re-feeds it rows).
    const h = mount({ draft: "", picker: { prefix: "$", query: "alpha", index: 0 } });
    expect(h.result.current.filtered).toEqual([]);
    expect(h.result.current.note).toBeUndefined();
    expect(h.result.current.activeIndex).toBe(0);
    h.cleanup();
  });

  it("keeps rows while `<prefix><query>` is still a literal substring of the draft", () => {
    const h = mount({
      draft: "use $alpha for this",
      picker: { prefix: "$", query: "alpha", index: 0 },
    });
    expect(h.result.current.filtered.map((r) => r.name)).toEqual(["alpha-skill"]);
    h.cleanup();
  });
});

// --- activeIndex ------------------------------------------------------------

describe("useMentionPicker — the highlighted index is DERIVED, not clamped in place", () => {
  it("clamps an index past the end to the last row (a Space switch refetches under an open picker)", () => {
    // Three skills match `$a` (`alpha-skill`, `beta-tool`, `gamma` — the filter
    // is case-insensitive), so a stale `index: 9` must land on 2 rather than
    // indexing into `undefined` and crashing `selectMention` on Enter.
    const h = mount({ draft: "$a", picker: { prefix: "$", query: "a", index: 9 } });
    expect(h.result.current.filtered).toHaveLength(3);
    expect(h.result.current.activeIndex).toBe(2);
    h.cleanup();
  });

  it("is 0 while the picker is closed (a note-only picker has no row to highlight)", () => {
    const h = mount({ draft: "", picker: null });
    expect(h.result.current.activeIndex).toBe(0);
    h.cleanup();
  });
});

// --- selectMention ----------------------------------------------------------

describe("useMentionPicker.selectMention — the insertion policy splits on the prefix", () => {
  it("a Mention row inserts `<prefix><name> ` LOWER-cased at the caret and closes the picker", () => {
    const h = mount({ draft: "run $alp", picker: { prefix: "$", query: "alp", index: 0 } });
    h.setCaret("run $alp".length);
    const row = h.result.current.filtered.find((r) => r.name === "alpha-skill")!;
    act(() => h.result.current.selectMention(row));
    expect(h.result.current.draft).toBe("run $alpha-skill ");
    expect(h.result.current.picker).toBeNull();
    h.cleanup();
  });

  it("a `?` FILE row inserts the path VERBATIM (case PRESERVED) and CONSUMES the `?`", () => {
    const h = mount({
      draft: "read ?REA",
      picker: { prefix: "?", query: "REA", index: 0 },
      files: listing(["README.md"]),
    });
    h.setCaret("read ?REA".length);
    const row = h.result.current.filtered[0]!;
    act(() => h.result.current.selectMention(row));
    // No lowercasing rule applies to a path, so the Mention policy does not
    // reach here — and the trigger is gone.
    expect(h.result.current.draft).toBe("read README.md ");
    expect(h.result.current.picker).toBeNull();
    h.cleanup();
  });

  it("a `?` DIRECTORY row keeps the `?`, appends `/` with NO space, and keeps the picker LIVE", () => {
    const h = mount({
      draft: "?~/.config/",
      picker: { prefix: "?", query: "~/.config/", index: 0 },
      completion: dir([
        dirEntry("htop", { insert: "/home/u/.config/htop", isDir: true }),
      ]),
    });
    h.setCaret("?~/.config/".length);
    const row = h.result.current.filtered[0]!;
    act(() => h.result.current.selectMention(row));
    expect(h.result.current.draft).toBe("?/home/u/.config/htop/");
    // The picker stays open on the directory just entered: the caret restore
    // fires NEITHER `onChange` nor `onKeyDown`, so the same handler recomputes
    // the token — consuming the sigil here would end the token and strand the
    // user after one level of descent.
    expect(h.result.current.picker).toEqual({
      prefix: "?",
      query: "/home/u/.config/htop/",
      index: 0,
    });
    h.cleanup();
  });

  it("restores focus and the caret after the insert (the controlled textarea would drop both)", async () => {
    const h = mount({ draft: "run $alp", picker: { prefix: "$", query: "alp", index: 0 } });
    h.setCaret("run $alp".length);
    const row = h.result.current.filtered.find((r) => r.name === "alpha-skill")!;
    act(() => h.result.current.selectMention(row));
    await flushFrames();
    expect(document.activeElement).toBe(h.textarea);
    const pos = "run ".length + "$alpha-skill ".length;
    expect(h.textarea.selectionStart).toBe(pos);
    h.cleanup();
  });

  it("is a silent no-op with a closed picker", () => {
    const h = mount({ draft: "no token here", picker: null });
    act(() =>
      h.result.current.selectMention({
        key: "x",
        prefix: "$",
        name: "x",
        description: "",
      }),
    );
    expect(h.result.current.draft).toBe("no token here");
    h.cleanup();
  });

  it("is a silent no-op when the caret no longer sits in a token", () => {
    // The picker state can outlive its token (it is only recomputed on
    // `onChange`/`onKeyDown`); a row click then must not splice text in.
    const h = mount({
      draft: "plain prose",
      picker: { prefix: "$", query: "", index: 0 },
    });
    h.setCaret("plain prose".length);
    act(() =>
      h.result.current.selectMention({
        key: "x",
        prefix: "$",
        name: "x",
        description: "",
      }),
    );
    expect(h.result.current.draft).toBe("plain prose");
    h.cleanup();
  });
});

// --- the insert-skill listener ---------------------------------------------

describe("useMentionPicker — the `archimedes:insert-skill` listener", () => {
  it("inserts the skill text at the caret and re-focuses", async () => {
    const h = mount({ draft: "hello " });
    h.setCaret("hello ".length);
    act(() => {
      window.dispatchEvent(
        new CustomEvent(IPC_EVENTS.insertSkill, { detail: "$beta " }),
      );
    });
    expect(h.result.current.draft).toBe("hello $beta ");
    await flushFrames();
    expect(document.activeElement).toBe(h.textarea);
    expect(h.textarea.selectionStart).toBe("hello $beta ".length);
    h.cleanup();
  });

  it("closes an OPEN picker first — an insert from OUTSIDE the picker makes it stale", () => {
    const h = mount({ draft: "$al", picker: { prefix: "$", query: "al", index: 0 } });
    act(() => {
      window.dispatchEvent(
        new CustomEvent(IPC_EVENTS.insertSkill, { detail: "$beta " }),
      );
    });
    expect(h.result.current.picker).toBeNull();
    h.cleanup();
  });

  it("reads the LIVE draft through the ref, not the mount-time closure", () => {
    // The effect runs ONCE (fast successive events with no re-render in between
    // would otherwise splice into a stale string).
    const h = mount({ draft: "one " });
    act(() => {
      h.result.current.setDraft("typed since mount ");
    });
    h.setCaret("typed since mount ".length);
    act(() => {
      window.dispatchEvent(
        new CustomEvent(IPC_EVENTS.insertSkill, { detail: "$beta " }),
      );
    });
    expect(h.result.current.draft).toBe("typed since mount $beta ");
    h.cleanup();
  });

  it("ignores a non-string detail (a window-global seam accepts anything)", () => {
    const h = mount({ draft: "hello" });
    act(() => {
      window.dispatchEvent(
        new CustomEvent(IPC_EVENTS.insertSkill, { detail: 42 }),
      );
    });
    // The picker still closes (that half runs first, on purpose), and the draft
    // is NOT `hello42`.
    expect(h.result.current.picker).toBeNull();
    expect(h.result.current.draft).toBe("hello");
    h.cleanup();
  });

  it("stops listening after unmount (a leaked listener would write into a dead draft)", () => {
    const h = mount({ draft: "hello" });
    h.unmount();
    act(() => {
      window.dispatchEvent(
        new CustomEvent(IPC_EVENTS.insertSkill, { detail: "$beta " }),
      );
    });
    // The hook is gone, so nothing observed it.
    expect(h.result.current.draft).toBe("hello");
    h.cleanup();
  });
});

// --- the argument surface ---------------------------------------------------

describe("useMentionPicker — the argument surface", () => {
  it("returns exactly the six fields `ChatStream` threads into `ComposerRow`, and no more", () => {
    const h = mount();
    // The harness adds `draft`/`setDraft` (its own state) and `textarea` (its
    // own ref); everything else IS the hook's return. `completionPending` and
    // `dirPrefix` are conspicuously ABSENT — both belong to the fetch the
    // caller owns.
    expect(Object.keys(h.result.current).sort()).toEqual([
      "activeIndex",
      "draft",
      "filtered",
      "note",
      "picker",
      "selectMention",
      "setDraft",
      "setPicker",
      "textarea",
    ]);
    h.cleanup();
  });

  it("takes the catalogs as values and owns no fetch (the caller keeps `useCompletionDir`)", () => {
    // The `dirPrefix` DERIVATION stays in `ChatStream` on purpose: `dirPrefix`
    // is the completion catalog's CACHE KEY, and with it as an argument a hook
    // can only show "same input, same output" — which cannot prove the KEY is
    // the directory rather than the whole remainder. That pin lives at
    // component level (`ChatStream.test.tsx`), and this test only records that
    // the boundary stayed where that pin needs it.
    const first = mount({
      draft: "?~/.config/ht",
      picker: { prefix: "?", query: "~/.config/ht", index: 0 },
      completion: dir([dirEntry("htop")]),
    });
    expect(first.result.current.filtered.map((r) => r.name)).toEqual([
      "/home/u/.config/htop",
    ]);
    first.cleanup();

    // A different payload for the same token renders different rows — the rows
    // follow the ARGUMENT, so no fetch state hides inside the hook.
    const second = mount({
      draft: "?~/.config/ht",
      picker: { prefix: "?", query: "~/.config/ht", index: 0 },
      completion: dir([dirEntry("htaccess", { insert: "/home/u/.config/htaccess" })]),
    });
    expect(second.result.current.filtered.map((r) => r.name)).toEqual([
      "/home/u/.config/htaccess",
    ]);
    second.cleanup();
  });
});
