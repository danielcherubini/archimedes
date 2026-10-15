import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock the Tauri IPC core (the `version.test.ts` pattern): the wrappers in
// this module are ONE-LINE `invoke` calls, so the only thing worth pinning is
// the WIRE CONTRACT — the command name and the argument keys. Nothing else
// does: the hook tests mock this WRAPPER (so they cannot see a renamed command
// or a re-typed arg key), and no Rust test registers `commands::files`, so a
// drift here — e.g. `spacePath` vs Rust's `space_path`, or
// `list_space_files` renamed — would pass every test on BOTH sides and fail
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
  listCompletionEntries,
  listSpaceFiles,
  type WindowFrameState,
} from "./tauri";

const mockedInvoke = vi.mocked(invoke);
const mockedListen = vi.mocked(listen);

describe("listSpaceFiles (the `?` File-completion IPC boundary, ADR 0033)", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("invokes `list_space_files` with the `spacePath` argument key", async () => {
    mockedInvoke.mockResolvedValue({ entries: [], truncated: false });
    await listSpaceFiles("/x");
    // The command NAME and the arg KEY are both load-bearing: Tauri maps the
    // camelCase `spacePath` here to the snake_case `space_path` Rust
    // parameter, and a typo in either is a runtime-only failure.
    expect(mockedInvoke).toHaveBeenCalledWith("list_space_files", {
      spacePath: "/x",
    });
  });

  it("passes null through as `{ spacePath: null }` (no Space: the empty listing, not an error)", async () => {
    mockedInvoke.mockResolvedValue({ entries: [], truncated: false });
    await listSpaceFiles(null);
    expect(mockedInvoke).toHaveBeenCalledWith("list_space_files", {
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
    await expect(listSpaceFiles("/x")).resolves.toEqual(payload);
    await expect(listSpaceFiles("/x")).resolves.toEqual({
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
    // test covers. This is the `listSpaceFiles` shape, kept deliberately.
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
    // Same trap as `list_space_files` above: Tauri maps the camelCase arg KEY
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
    // Same trap as `list_space_files` above: Tauri maps the camelCase arg KEY
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
    // Same trap as `list_space_files` above: Tauri maps these arg KEYS to the
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
