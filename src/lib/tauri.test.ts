import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock the Tauri IPC core (the `version.test.ts` pattern): the wrappers in
// this module are ONE-LINE `invoke` calls, so the only thing worth pinning is
// the WIRE CONTRACT — the command name and the argument keys. Nothing else
// does: the hook tests mock this WRAPPER (so they cannot see a renamed command
// or a re-typed arg key), and no Rust test registers `commands::files`, so a
// drift here — e.g. `spacePath` vs Rust's `space_path`, or
// `list_space_listing` renamed — would pass every test on BOTH sides and fail
// only at runtime, in the desktop app.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen, type EventCallback } from "@tauri-apps/api/event";
import {
  attentionArm,
  attentionDisarm,
  compactSession,
  externalOpen,
  getWindowState,
  listenWindowState,
  listAgentDefinitionReports,
  listCompletionEntries,
  listSpaceListing,
  loadHistory,
  reorderSessions,
  reorderSpaces,
  sessionRecency,
  type AgentDefinitionReportDto,
  type WindowFrameState,
} from "./tauri";

const mockedInvoke = vi.mocked(invoke);
const mockedListen = vi.mocked(listen);

describe("listSpaceListing (the `?` File-completion IPC boundary, ADR 0033)", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("invokes `list_space_listing` with the `spacePath` argument key", async () => {
    mockedInvoke.mockResolvedValue({ entries: [], truncated: false });
    await listSpaceListing("/x");
    // The command NAME and the arg KEY are both load-bearing: Tauri maps the
    // camelCase `spacePath` here to the snake_case `space_path` Rust
    // parameter, and a typo in either is a runtime-only failure.
    expect(mockedInvoke).toHaveBeenCalledWith("list_space_listing", {
      spacePath: "/x",
    });
  });

  it("passes null through as `{ spacePath: null }` (no Space: the empty listing, not an error)", async () => {
    mockedInvoke.mockResolvedValue({ entries: [], truncated: false });
    await listSpaceListing(null);
    expect(mockedInvoke).toHaveBeenCalledWith("list_space_listing", {
      spacePath: null,
    });
  });

  it("returns the `{ entries, truncated }` payload UNCHANGED (no reshaping)", async () => {
    // `truncated` is the flag the picker's note is built from, so a wrapper
    // that dropped or renamed it would silently kill the note.
    const payload = {
      entries: ["README.md", "src/main.rs"],
      truncated: true,
    };
    mockedInvoke.mockResolvedValue(payload);
    await expect(listSpaceListing("/x")).resolves.toEqual(payload);
    await expect(listSpaceListing("/x")).resolves.toEqual({
      entries: ["README.md", "src/main.rs"],
      truncated: true,
    });
  });
});

describe("listCompletionEntries (the out-of-Space `?` IPC boundary, ADR 0035)", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("invokes `list_completion_entries` with the `query` argument key", async () => {
    mockedInvoke.mockResolvedValue({ entries: [], truncated: false });
    await listCompletionEntries("~/.config/ht");
    // Same trap as above: Tauri maps the camelCase arg KEY to the snake_case
    // Rust parameter, and a typo in the name or the key is a runtime-only
    // failure in the desktop app that no Rust test and no hook test can see.
    expect(mockedInvoke).toHaveBeenCalledWith("list_completion_entries", {
      query: "~/.config/ht",
    });
  });

  it("passes null through as `{ query: null }` (no token: the empty listing, no error)", async () => {
    // PASSED THROUGH, not short-circuited client-side — the Rust `None` arm is
    // the one place that guarantees "no token costs no filesystem access", and a
    // wrapper-level early return would move that guarantee somewhere no Rust
    // test covers. This is the `listSpaceListing` shape, kept deliberately.
    mockedInvoke.mockResolvedValue({ entries: [], truncated: false });
    await listCompletionEntries(null);
    expect(mockedInvoke).toHaveBeenCalledWith("list_completion_entries", {
      query: null,
    });
  });

  it("returns the `{ entries, truncated }` payload UNCHANGED (no reshaping)", async () => {
    // The row shape is pinned here rather than left to Task 4, because the DTO
    // crosses IPC as camelCase (`isDir` for Rust's `is_dir`): a rename on either
    // side is invisible to both test suites and shows up as every row looking
    // like a file.
    const payload = {
      entries: [
        {
          name: "htop",
          insert: "/home/u/.config/htop",
          display: "~/.config/htop",
          isDir: true,
        },
        {
          name: "config",
          insert: "/home/u/.config/htop/config",
          display: "~/.config/htop/config",
          isDir: false,
        },
      ],
      truncated: true,
    };
    mockedInvoke.mockResolvedValue(payload);
    await expect(listCompletionEntries("~/.config/")).resolves.toEqual(payload);
  });
});

describe("compactSession (the `/compact` Composer-command IPC boundary, ADR 0044)", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("invokes `compact_session` with the `sessionId`/`instructions` argument keys", async () => {
    mockedInvoke.mockResolvedValue(true);
    await compactSession("s1", "keep the tests");
    // Same trap as `list_space_listing` above: Tauri maps the camelCase arg KEY
    // to the snake_case Rust parameter (`sessionId` → `session_id`,
    // `instructions` → `instructions` in `commands::sessions::compact_session`),
    // and a typo in the command NAME or in either KEY is a runtime-only failure
    // no Rust test and no component test (which mocks THIS wrapper) can see.
    expect(mockedInvoke).toHaveBeenCalledWith("compact_session", {
      sessionId: "s1",
      instructions: "keep the tests",
    });
  });

  it("passes a null `instructions` through as null (no args is not an empty string)", async () => {
    // `/compact` with no args means "no extra instructions", which the Rust side
    // models as `Option<String> = None`. A wrapper that normalized `null` the way
    // `sendPrompt` normalizes `images` (`?? []`) would send `""` and make the
    // harness summarize against an empty instruction string instead of its own
    // default — a quiet behaviour change inside the harness's prompt.
    mockedInvoke.mockResolvedValue(true);
    await compactSession("s1", null);
    expect(mockedInvoke).toHaveBeenCalledWith("compact_session", {
      sessionId: "s1",
      instructions: null,
    });
  });

  it("returns the command's bool UNCHANGED (false is the not-live answer)", async () => {
    // `false` is NOT an error — a stored (non-live) session is a NO-OP, and the
    // composer's one-line "Nothing to compact" message is built from exactly
    // this value, so a wrapper that swallowed or reshaped it would silence the
    // only feedback the no-op path has.
    mockedInvoke.mockResolvedValue(false);
    await expect(compactSession("s1", null)).resolves.toBe(false);
    mockedInvoke.mockResolvedValue(true);
    await expect(compactSession("s1", "x")).resolves.toBe(true);
  });
});

describe("attention arm/disarm (the ADR 0039 IPC boundary)", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("invokes `attention_arm` with the `delaySecs`/`title`/`body` argument keys", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    await attentionArm(15, "Archimedes", "b");
    // Same trap as `list_space_listing` above: Tauri maps the camelCase arg KEY
    // to the snake_case Rust parameter (`delaySecs` here → `delay_secs` in
    // `commands::attention::attention_arm`), and a typo in the command NAME or
    // in any KEY is a runtime-only failure the hook tests cannot see.
    expect(mockedInvoke).toHaveBeenCalledWith("attention_arm", {
      delaySecs: 15,
      title: "Archimedes",
      body: "b",
    });
  });

  it("passes a `0` delay through as `delaySecs: 0` (meaning 'fire immediately', not 'never')", async () => {
    // Rust's `countdown(0)` is `Duration::ZERO` — the deadline is REAL and
    // `min`-capped, never defaulted — so a falsy-guarded wrapper (`delaySecs ||
    // undefined`) would turn the shortest possible alert into no alert.
    mockedInvoke.mockResolvedValue(undefined);
    await attentionArm(0, "Archimedes", "b");
    expect(mockedInvoke).toHaveBeenCalledWith("attention_arm", {
      delaySecs: 0,
      title: "Archimedes",
      body: "b",
    });
  });

  it("invokes `attention_disarm` with NO payload (the exact no-args form)", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    await attentionDisarm();
    // Pinned to the ZERO-arg call on purpose: `attention_disarm` takes only
    // `State<Arc<AttentionTimer>>` on the Rust side, so there is no expected
    // args object — `{}` would be a different call to `invoke` and this is the
    // one place that drift could be caught.
    expect(mockedInvoke).toHaveBeenCalledWith("attention_disarm");
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
  });
});

describe("externalOpen (the External-open IPC boundary, ADR 0051)", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockedInvoke.mockReset();
    // The refusal path logs; a test that left the spy in place would print a
    // wall of warnings for every later case in this file.
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("invokes `external_open` with the `href`/`cwd` argument keys", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    await externalOpen("https://x.test", "/home/u/proj");
    // Same trap as `list_space_listing` above: Tauri maps these arg KEYS to the
    // `commands::open::external_open` parameters (`href`, `cwd` — both single
    // words, so no casing alias is involved and a typo is pure silence), and a
    // typo in the command NAME or in either KEY is a runtime-only failure no
    // Rust test can see (the Rust tests call `external_open` DIRECTLY — nothing
    // in this repo goes over IPC in a test) and no component test can see
    // (Task 4+ mock THIS wrapper, so they cannot observe the wire at all).
    expect(mockedInvoke).toHaveBeenCalledWith("external_open", {
      href: "https://x.test",
      cwd: "/home/u/proj",
    });
  });

  it("sends `cwd: null` for an omitted/undefined/null cwd — NEVER an absent key or undefined", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    await externalOpen("README.md");
    await externalOpen("README.md", undefined);
    await externalOpen("README.md", null);
    // `cwd` is `Option<String>` on the Rust side, so an ABSENT key would also
    // deserialize to `None` — which is exactly why `null` is asserted here as
    // a CONTRACT rather than as a necessity: the wrapper promises one explicit
    // shape on the wire, and a future `cwd ? { cwd } : {}`-style conditional
    // spread (or dropping `?? null`) is a silent change of shape. `toHaveBeenCalledWith`
    // already distinguishes `null` from `undefined`/absent; the `in` check below
    // says the same thing out loud.
    for (const call of mockedInvoke.mock.calls) {
      const args = call[1] as Record<string, unknown>;
      expect(call[0]).toBe("external_open");
      expect("cwd" in args).toBe(true);
      expect(args.cwd).toBeNull();
    }
    expect(mockedInvoke).toHaveBeenLastCalledWith("external_open", {
      href: "README.md",
      cwd: null,
    });
  });

  it("RESOLVES and warns when the command rejects (a refusal is not an unhandled rejection)", async () => {
    // The Rust side returns the typed refusal code (`Refusal::code()`, e.g.
    // `denied-scheme:javascript`) or `os-error:…`. Neither may become a
    // rejected promise: every caller is a click handler with no `catch`, so a
    // rejection here is an unhandled rejection in the webview console and zero
    // diagnostics for the user-visible "nothing happened".
    mockedInvoke.mockRejectedValue("denied-scheme:javascript");
    await expect(
      externalOpen("javascript:alert(1)", "/home/u/proj"),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    // The refusal reason travels in the first argument (the wire string), the
    // href the user clicked in the second — both are needed to tell "refused by
    // policy" apart from "the OS handler failed" when reading a bug report.
    expect(warn.mock.calls[0][0]).toContain("denied-scheme:javascript");
    expect(warn.mock.calls[0][1]).toBe("javascript:alert(1)");
  });

  it("RESOLVES when the OS handler fails (`os-error:…` is a warn too)", async () => {
    mockedInvoke.mockRejectedValue(new Error("os-error:no handler"));
    await expect(externalOpen("/home/u/proj/notes.md", null)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("os-error:no handler");
  });
});

describe("getWindowState / listenWindowState (the Linux window tiling IPC boundary)", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedListen.mockReset();
  });

  it("invokes `get_window_state` with no payload", async () => {
    const payload = {
      isTiled: true,
      isMaximized: false,
      isFullscreen: false,
      native: true,
    };
    mockedInvoke.mockResolvedValue(payload);

    const result = await getWindowState();
    expect(mockedInvoke).toHaveBeenCalledWith("get_window_state");
    expect(result).toEqual(payload);
  });

  it("registers `listenWindowState` on the `window-state-changed` event and forwards payload", async () => {
    const unlisten = vi.fn();
    let eventCallback: EventCallback<WindowFrameState> | undefined;
    mockedListen.mockImplementation((_event, cb) => {
      eventCallback = cb as EventCallback<WindowFrameState>;
      return Promise.resolve(unlisten);
    });

    const handler = vi.fn();
    const resultUnlisten = await listenWindowState(handler);

    expect(mockedListen).toHaveBeenCalledWith(
      "window-state-changed",
      expect.any(Function),
    );
    expect(resultUnlisten).toBe(unlisten);

    const payload: WindowFrameState = {
      isTiled: true,
      isMaximized: false,
      isFullscreen: false,
      native: true,
    };
    eventCallback?.({
      event: "window-state-changed",
      id: 1,
      payload,
    });
    expect(handler).toHaveBeenCalledWith(payload);
  });
});

describe("loadHistory (the paged history IPC boundary, ADR 0073)", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("invokes load_history with nulls when opts are omitted", async () => {
    const payload = { rows: [], hasMore: false, todos: null };
    mockedInvoke.mockResolvedValue(payload);

    const result = await loadHistory("sess-1");
    expect(mockedInvoke).toHaveBeenCalledWith("load_history", {
      sessionId: "sess-1",
      limit: null,
      beforeId: null,
    });
    expect(result).toEqual(payload);
  });

  it("passes limit and beforeId when provided", async () => {
    const payload = { rows: [], hasMore: true, todos: null };
    mockedInvoke.mockResolvedValue(payload);

    const result = await loadHistory("sess-1", { limit: 500, beforeId: 42 });
    expect(mockedInvoke).toHaveBeenCalledWith("load_history", {
      sessionId: "sess-1",
      limit: 500,
      beforeId: 42,
    });
    expect(result).toEqual(payload);
  });
});

describe("listAgentDefinitionReports (the sidebar Agents modal's IPC boundary, ADR 0068)", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("invokes `list_agent_definition_reports` with the `cwd` argument key", async () => {
    mockedInvoke.mockResolvedValue([]);
    await listAgentDefinitionReports("/p/space");
    // Same trap as `list_space_listing` above: Tauri maps a camelCase arg KEY to
    // the snake_case Rust parameter, and `listSkills` proves the rule costs a
    // rename (its Rust `space_path` is sent as `spacePath`). `cwd` is ONE word,
    // so it must stay `cwd` — `cwdPath`/`spacePath` here is a runtime-only
    // failure no Rust test can see (the Rust tests call `agent_definition_reports`
    // directly, never over IPC) and no hook test can see (Task 5 mocks THIS
    // wrapper). `listAgentDefinitionsForSpace` is the neighbouring precedent
    // for the exact same key on the same-shaped command.
    expect(mockedInvoke).toHaveBeenCalledWith("list_agent_definition_reports", {
      cwd: "/p/space",
    });
  });

  it("sends `cwd: null` for the app-scope call — NEVER an omitted key", async () => {
    mockedInvoke.mockResolvedValue([]);
    await listAgentDefinitionReports(null);
    // `cwd` is `Option<String>` on the Rust side, so an ABSENT key would also
    // deserialize to `None` — which is exactly why the explicit `null` is
    // asserted as a CONTRACT and not as a necessity: it is what the
    // neighbouring wrappers do (`{ cwd: spacePath ?? null }`), and a future
    // `cwd ? { cwd } : {}` would silently change the wire shape.
    // `toHaveBeenCalledWith` already distinguishes `null` from absent; the `in`
    // check says it out loud, as the `externalOpen` pin above does.
    const args = mockedInvoke.mock.calls[0][1] as Record<string, unknown>;
    expect(mockedInvoke.mock.calls[0][0]).toBe("list_agent_definition_reports");
    expect("cwd" in args).toBe(true);
    expect(args.cwd).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledWith("list_agent_definition_reports", {
      cwd: null,
    });
  });

  it("returns the rows UNCHANGED (no reshaping of the report)", async () => {
    // The row shape is pinned here rather than left to the modal's tests,
    // because every name below crosses IPC: `override_` in Rust (a keyword)
    // ships as `override`, and the three column structs serialize their
    // `Option`s ALWAYS PRESENT as `null` (no `skip_serializing_if`) — which is
    // why the TypeScript fields are `string | null` and not optional. A rename
    // on either side is invisible to both suites and shows up as a modal that
    // renders "Inherits parent" for a value the file actually set. The payload
    // is a REAL serialized row (ADR 0068's `shadowed` included, required and
    // empty-as-`[]`).
    //
    // issue #101 added TWO more fields and this pin GAINED them as ASSERTIONS,
    // not as quiet fixture edits. The block below is written in the exact
    // spelling `definition_permission.rs` produces — `tools` is an ORDERED ARRAY
    // OF PAIRS (Rust serializes `Vec<(ToolKey, Rules)>` as a 2-element JSON
    // array, never an object), `whole_tool` is SNAKE_CASE (`Rules` carries no
    // `rename_all`, and a rename on the parent DTO never reaches a nested type),
    // `action` is the lowercase verb, and a note is ONE TAGGED OBJECT
    // (`{"unknownKey":"mode"}`) because `FrontmatterNote` is EXTERNALLY tagged.
    // The assertions beneath pin those SERIALISED ELEMENTS rather than a bare
    // `contains`, so a renamed field or a re-tagged enum reddens THIS test —
    // which matters more here than anywhere, because this repo has no Rust↔TS
    // wire-contract test and both suites would otherwise stay green on a drift.
    const row: AgentDefinitionReportDto = {
      name: "scout",
      description: "Fast recon.",
      scope: "space",
      path: "/p/scout.md",
      file: {
        model: "fake/m1",
        thinking: null,
        tools: null,
        permission: {
          tools: [
            ["bash", { patterns: [{ pattern: "*", action: "deny" }], whole_tool: true }],
            [{ unrecognized: "glob" }, { patterns: [{ pattern: "*.json", action: "ask" }], whole_tool: false }],
          ],
        },
      },
      override: { model: null, thinking: null, tools: null, permission: null },
      effective: { model: "fake/m1", thinking: null, tools: null, permission: null },
      source: { model: "file", thinking: "parent", tools: "parent", permission: "file" },
      shadowed: [{ name: "scout", path: "/u/scout.md", scope: "user" }],
      // The row-level declared block, the SAME block the `file` column carries
      // (Rust clones it from the definition twice — `file_permission` and
      // `file_fields(def).permission` are one value).
      filePermission: {
        tools: [
          ["bash", { patterns: [{ pattern: "*", action: "deny" }], whole_tool: true }],
          [{ unrecognized: "glob" }, { patterns: [{ pattern: "*.json", action: "ask" }], whole_tool: false }],
        ],
      },
      // REQUIRED like `shadowed`: a clean file's empty `Vec` is `[]`, never
      // `null` and never an absent key.
      frontmatterNotes: [{ unknownKey: "mode" }, { unrecognizedToolKey: "glob" }],
    };
    mockedInvoke.mockResolvedValue([row]);
    await expect(listAgentDefinitionReports("/p/space")).resolves.toEqual([row]);

    // And the column is read as `override`, never Rust's `override_` (a
    // keyword): this compile-time field access IS the pin — a TS type that
    // declared `override_` would not type-check here, and the modal's editor
    // would read a column that never arrives.
    const [out] = await listAgentDefinitionReports("/p/space");
    expect(out.override).toEqual({
      model: null,
      thinking: null,
      tools: null,
      // The stored entry has NO `permission` key at all (ADR 0066's shape is
      // model/thinking/tools), so this column is `null` by construction — never
      // a block, and never `override` in the source column either.
      permission: null,
    });
    expect(out.source.model).toBe("file");
    expect(out.shadowed).toHaveLength(1);

    // ---- issue #101: the permission wire spellings, asserted as ELEMENTS ----

    // The block is the ORDERED PAIR ARRAY, in file order — `bash` first because
    // the file wrote it first, and an assertion that read it as an object could
    // not observe that order at all.
    expect(out.filePermission).toEqual({
      tools: [
        ["bash", { patterns: [{ pattern: "*", action: "deny" }], whole_tool: true }],
        [{ unrecognized: "glob" }, { patterns: [{ pattern: "*.json", action: "ask" }], whole_tool: false }],
      ],
    });
    // THE snake_case key, asserted by name: `whole_tool` and NOT `wholeTool`.
    // A TS mirror that guessed camelCase would read `undefined` here and the
    // row would render a tool-wide deny as a pattern rule — the exact silent
    // drift no other test in either suite can see.
    expect(out.filePermission!.tools[0]![1]).toHaveProperty("whole_tool", true);
    expect(out.filePermission!.tools[0]![1]).not.toHaveProperty("wholeTool");
    // The lowercase verb, and the externally-tagged `ToolKey::Unrecognized`
    // object that keeps an unpoliced key's verbatim name.
    expect(out.filePermission!.tools[0]![1].patterns[0]!.action).toBe("deny");
    expect(out.filePermission!.tools[1]![0]).toEqual({ unrecognized: "glob" });
    // The notes, one TAGGED OBJECT per note, in order. `toEqual` on the whole
    // array is the rot-proof form: a `{kind, value}` mirror of these objects
    // fails it, where `JSON.stringify(...).includes("mode")` would pass.
    expect(out.frontmatterNotes).toEqual([
      { unknownKey: "mode" },
      { unrecognizedToolKey: "glob" },
    ]);
    // `source.permission` is `file` here — Rust reports the FILE layer exactly
    // when the block exists, and there is no fourth `OverrideSource` variant.
    expect(out.source.permission).toBe("file");
  });

  it("a file that says nothing about permissions still sends both fields", async () => {
    // The empty-case wire shape, pinned separately because it is the shape
    // EVERY row in the ordinary install arrives as, and because the two fields
    // are empty in two DIFFERENT ways: `filePermission` is Rust `Option` so it
    // is `null`, while `frontmatterNotes` is a REQUIRED `Vec` so it is `[]`.
    // A mirror that declared the notes `null`-able, or the block optional,
    // would read fine here and lie about the wire.
    const row: AgentDefinitionReportDto = {
      name: "scout",
      description: "Fast recon.",
      scope: "space",
      path: "/p/scout.md",
      file: { model: null, thinking: null, tools: null, permission: null },
      override: { model: null, thinking: null, tools: null, permission: null },
      effective: { model: null, thinking: null, tools: null, permission: null },
      source: { model: "parent", thinking: "parent", tools: "parent", permission: "parent" },
      shadowed: [],
      filePermission: null,
      frontmatterNotes: [],
    };
    mockedInvoke.mockResolvedValue([row]);
    const [out] = await listAgentDefinitionReports("/p/space");
    expect(out.filePermission).toBeNull();
    expect(out.frontmatterNotes).toEqual([]);
    // No block ⇒ no file layer: Rust reports `parent`, never a fourth word.
    expect(out.source.permission).toBe("parent");
  });
});


describe("sessionRecency (the ADR 0075 recency IPC boundary)", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("invokes `session_recency` with no payload", async () => {
    // Same trap as `list_space_listing` above: the Rust command is
    // `commands::history::session_recency` and NOTHING in this repo drives it
    // over IPC in a test (the Rust tests call `Db::session_recency` directly),
    // so a renamed command or a stray argument object is a runtime-only failure
    // in the desktop app. Pinned to the ZERO-arg call, as `attention_disarm` is:
    // the command takes only `State<Arc<Db>>`, so `{}` would be a different call
    // to `invoke` and this is the one place that drift can be caught.
    const payload = [{ sessionId: "s1", lastActiveAt: 9_999_999_999_999 }];
    mockedInvoke.mockResolvedValue(payload);
    await expect(sessionRecency()).resolves.toEqual(payload);
    // The rows come back UNCHANGED (the store keys them by `sessionId` itself).
    // The stamp is the far-future one, per the fixture rule: a mocked payload
    // must not be able to look like a `now_ms()` value, so a wrapper that
    // invented or defaulted `lastActiveAt` cannot pass this green.
    expect(mockedInvoke).toHaveBeenCalledWith("session_recency");
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
  });
});

describe("reorderSessions (the sidebar drag write path, ADR 0075)", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("invokes `reorder_sessions` with the `ids` argument key", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    await reorderSessions(["s2", "s1", "s3"]);
    // The ORDER is asserted exactly as given: the argument is the sidebar's
    // whole visible slice of ONE Space in its new order, and
    // `Db::reorder_sessions` writes the slice index as each row's stored order
    // number. A wrapper that sorted, deduped or
    // otherwise tidied the list would silently corrupt the drag and stay green
    // on every other surface.
    expect(mockedInvoke).toHaveBeenCalledWith("reorder_sessions", {
      ids: ["s2", "s1", "s3"],
    });
  });
});

describe("reorderSpaces (the tab-strip drag write path, ADR 0075)", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("invokes `reorder_spaces` with the `paths` argument key", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    await reorderSpaces(["/b", "/a"]);
    // `paths`, NOT `ids`: the `spaces` table is keyed by the canonical path
    // (`space_key`), and the command layer passes it through RAW (no
    // re-canonicalizing — a folder that vanished mid-drag would otherwise be
    // skipped and leave a PARTIAL renumber). The KEY name is the whole contract:
    // `{ ids: [...] }` against Rust's `paths` parameter is a runtime-only failure
    // no Rust test and no component test can see.
    expect(mockedInvoke).toHaveBeenCalledWith("reorder_spaces", {
      paths: ["/b", "/a"],
    });
  });
});
