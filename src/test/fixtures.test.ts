import { describe, expect, it, vi } from "vitest";
import type { AppSettings, SessionInfo, SpaceRow } from "../lib/tauri";
import type { Message } from "../store/sessions";
import type { SubagentEntry } from "../store/subagents";
import type { SessionConfigSource } from "../lib/sessionConfig";
import {
  getSettings,
  type SessionConfigOption,
} from "../lib/tauri";
import { useSessions } from "../store/sessions";
import { useSettings } from "../store/settings";
import { useSubagents } from "../store/subagents";
import { useInteractive } from "../store/interactive";
import { useSubagentSelection } from "../store/subagentSelection";
import { useQueuedPrompts } from "../store/queuedPrompts";
import { usePermissions } from "../store/permissions";
import {
  getLeftPaneCollapsed,
  setLeftPaneCollapsed,
} from "../lib/leftPaneState";
import {
  getSidePaneCollapsed,
  setSidePaneCollapsed,
} from "../lib/sidePaneState";
import {
  getNewSpaceDialogOpen,
  setNewSpaceDialogOpen,
} from "../lib/newSpaceDialogState";
import {
  DEFAULT_SETTINGS,
  makeConfigSource,
  makeMessage,
  makeSessionRow,
  makeSettings,
  makeSpaceRow,
  makeSubagentEntry,
  makeSubagentState,
} from "./fixtures";
import { resetModuleFlags, resetStores } from "./resetStores";

/**
 * The shared test seam (Finding 9, Task B4a).
 *
 * These tests exist because the seam is now load-bearing for EVERY future
 * component test: 25 files hand-copy an `AppSettings` literal, two of those
 * literals are byte-identical, and `App.test.tsx`'s copy is already stale
 * (missing `palette`) because nothing types it. A fixture nobody proves is a
 * second set of hand-copied literals with a nicer name, so this file asserts
 * the three things the seam actually promises:
 *
 *   1. `makeSettings()` supplies EVERY required `AppSettings` field — checked
 *      at RUNTIME against the field list, not with `expectTypeOf`, which never
 *      executes here (`vite.config.ts` has no `test.typecheck` block);
 *   2. `resetStores()` really clears a dirtied store — dirty it, reset, assert
 *      it is clean. This is the test that catches a `setState` shallow-merge
 *      bug, which is the failure mode that would leave a stale `messages` map
 *      under a test that believed it was starting fresh;
 *   3. the fixture module is reachable from inside a hoisted `vi.mock` factory
 *      (the `await import()` route) — the thing `SpacesList.test.tsx:100-104`
 *      records as impossible today.
 *
 * What this file deliberately does NOT do: pretend the seam isolates
 * module-scope state. The last test below asserts the OPPOSITE — that
 * `src/store/sessions.ts`'s module-local message-id counter keeps running
 * across `resetStores()` — so the helper's name cannot quietly promise an
 * isolation it does not provide.
 */

/**
 * The `vi.mock` factory below needs the fixture, and the factory is hoisted
 * above every import in this file — so the fixture is reached with
 * `await import()` INSIDE the factory (the factories in this repo are already
 * `async`). The assertion then reads the mocked module's own export, which
 * proves the fixture survived the hoist rather than trusting the comment.
 */
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  const { makeSettings } = await import("./fixtures/settings");
  return {
    ...actual,
    getSettings: vi.fn().mockResolvedValue(makeSettings()),
  };
});

/** Every required field of the real `AppSettings`, spelled independently of
 *  the fixture (from `src/lib/tauri.ts`). The fixture's key set must equal
 *  this list — that is the check the untyped literals never had. */
const APP_SETTINGS_FIELDS = [
  "theme",
  "palette",
  "paneLayout",
  "defaultTrustNewSpaces",
  "defaultModel",
  "defaultThinkingLevel",
  "enabledTools",
  "providers",
  "mcpServers",
  "font",
  "defaultThinkingLevels",
  "agentOverrides",
  "spinnerStyle",
  "emptyStateAnimation",
  "filePolicy",
  "web",
  "mcpMentionsEnabled",
  "sessionNamingEnabled",
  "sessionNamingModel",
  "sessionNamingReasoning",
  "attentionAlertsEnabled",
  "attentionAlertDelaySecs",
].sort();

describe("makeSettings — the one place AppSettings is spelled", () => {
  it("supplies all 22 required fields (runtime check — expectTypeOf never runs here)", () => {
    const settings: AppSettings = makeSettings();
    // The compile-time claim (`makeSettings(): AppSettings`) is ALSO a runtime
    // one here: an object literal typed as `AppSettings` cannot be checked by
    // `expectTypeOf` in this repo, so the key set is compared to the real
    // field list read off `src/lib/tauri.ts`.
    expect(Object.keys(settings).sort()).toEqual(APP_SETTINGS_FIELDS);
    expect(Object.keys(settings)).toHaveLength(22);
  });

  it("DEFAULT_SETTINGS carries the same field set (a stale literal is a compile error here)", () => {
    const complete: AppSettings = DEFAULT_SETTINGS;
    expect(Object.keys(complete).sort()).toEqual(APP_SETTINGS_FIELDS);
  });

  it("defaults are the shipped ones, not arbitrary placeholders", () => {
    const settings = makeSettings();
    // Each of these is the value the BACKEND serves on a fresh install, so a
    // fixture that drifted would make a test describe a settings document no
    // user can have.
    expect(settings.palette).toBeNull(); // `null` = "zai" (ADR 0027)
    expect(settings.filePolicy).toEqual({
      reads: "allow",
      writes: "allow",
      shell: "allow",
    }); // ADR 0030: all-`allow` is the derived default in every direction
    expect(settings.web).toEqual({
      braveApiKey: "",
      tavilyApiKey: "",
      perplexityApiKey: "",
      searxngUrl: "",
      defaultProvider: "auto",
      proxy: "",
    });
    expect(settings.font).toEqual({
      sizePx: 14,
      uiFamily: null,
      codeFamily: null,
    });
    expect(settings.agentOverrides).toEqual({});
    expect(settings.sessionNamingEnabled).toBe(true);
    expect(settings.mcpMentionsEnabled).toBe(false);
    expect(settings.attentionAlertsEnabled).toBe(true);
    expect(settings.attentionAlertDelaySecs).toBe(15);
  });

  it("applies overrides over the defaults", () => {
    const settings = makeSettings({ palette: "dracula", theme: "light" });
    expect(settings.palette).toBe("dracula");
    expect(settings.theme).toBe("light");
    // Untouched fields still come from the default.
    expect(settings.web.defaultProvider).toBe("auto");
  });

  it("hands each call its OWN nested objects (a test must not be able to corrupt the default)", () => {
    const a = makeSettings();
    const b = makeSettings();
    expect(a.font).not.toBe(b.font);
    expect(a.filePolicy).not.toBe(b.filePolicy);
    expect(a.web).not.toBe(b.web);
    expect(a.providers).not.toBe(b.providers);
    // Mutating one fixture's nested value cannot reach the shared default —
    // the failure mode a `{ ...DEFAULT_SETTINGS }` spread would have.
    a.font.sizePx = 999;
    a.enabledTools.push("poison");
    expect(makeSettings().font.sizePx).toBe(14);
    expect(makeSettings().enabledTools).toEqual([]);
    expect(DEFAULT_SETTINGS.font.sizePx).toBe(14);
  });
});

describe("makeSessionRow / makeSpaceRow (the sidebar's rows)", () => {
  it("defaults are internally consistent and carry NO optional key at all", () => {
    const row: SessionInfo = makeSessionRow();
    expect(row.sessionId).toBeTruthy();
    expect(row.cwd).toBeTruthy();
    expect(row.archived).toBe(false);
    expect(row.capabilities).toEqual({});
    // `title`/`contextUsage`/`configOptions` are OPTIONAL on `SessionInfo` and
    // absent (not `undefined`-valued) on the wire. A fixture that set them to
    // `undefined` would break every `toEqual(row)` comparison downstream —
    // `toEqual` ignores `undefined` properties, but `Object.keys`/`in` do not,
    // and the store branches on `info.configOptions ? … : …`.
    expect("title" in row).toBe(false);
    expect("contextUsage" in row).toBe(false);
    expect("configOptions" in row).toBe(false);
  });

  it("applies overrides and accepts the optional fields when asked", () => {
    const row = makeSessionRow({ sessionId: "s-9", cwd: "/w/other", archived: true });
    expect(row.sessionId).toBe("s-9");
    expect(row.cwd).toBe("/w/other");
    expect(row.archived).toBe(true);
    const withUsage = makeSessionRow({ contextUsage: { used: 10, window: 100 } });
    expect(withUsage.contextUsage).toEqual({ used: 10, window: 100 });
    expect("contextUsage" in withUsage).toBe(true);
  });

  it("makeSpaceRow defaults a closed, untrusted space row", () => {
    const row: SpaceRow = makeSpaceRow();
    expect(row.path).toBeTruthy();
    expect(row.trusted).toBe(false);
    expect(row.createdAt).toBeLessThanOrEqual(row.lastOpenedAt);
    expect(makeSpaceRow({ path: "/w/x", trusted: true }).trusted).toBe(true);
  });
});

describe("makeMessage (the transcript union, one factory)", () => {
  it("defaults to an agent-text message with a stable messageId", () => {
    const message: Message = makeMessage();
    expect(message.kind).toBe("agent-text");
    expect(message.at).toBeGreaterThan(0);
  });

  it("builds EVERY kind with that kind's required fields present", () => {
    const user = makeMessage("user", { text: "hi" });
    expect(user).toEqual({ kind: "user", text: "hi", at: expect.any(Number) });
    const thought = makeMessage("agent-thought");
    expect(thought.kind).toBe("agent-thought");
    expect(thought.messageId).toBeTruthy();
    const tool = makeMessage("tool-call", { title: "bash" });
    expect(tool.kind).toBe("tool-call");
    expect(tool.id).toBeTruthy();
    expect(tool.title).toBe("bash");
    expect(tool.status).toBeTruthy();
    const diff = makeMessage("diff", { path: "a.ts", patch: "@@ x" });
    expect(diff.kind).toBe("diff");
    expect(diff.path).toBe("a.ts");
    // A `tool-call` must NOT be able to smuggle a user-only field in.
    expect("text" in tool).toBe(false);
  });

  it("overrides win, and each call is a fresh object", () => {
    const a = makeMessage("user", { text: "first" });
    const b = makeMessage("user", { text: "second" });
    expect(a.text).toBe("first");
    expect(b.text).toBe("second");
    expect(a).not.toBe(b);
  });
});

describe("makeConfigSource (the three-list walk's input shape)", () => {
  it("defaults to every list and map empty, typed as SessionConfigSource", () => {
    const source: SessionConfigSource = makeConfigSource();
    expect(source.sessions).toEqual([]);
    expect(source.historySessions).toEqual([]);
    expect(source.archivedSessions).toEqual([]);
    expect(source.configOptions).toEqual({});
    expect(source.contextUsage).toEqual({});
  });

  it("places rows in the list the caller names (the walk's three cases need three placements)", () => {
    const live = makeSessionRow({ sessionId: "s1" });
    const stored = makeSessionRow({ sessionId: "s2", cwd: "/w/b" });
    const archived = makeSessionRow({ sessionId: "s3", archived: true });
    const option: SessionConfigOption = {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "gpt",
      options: [],
    };
    const source = makeConfigSource({
      sessions: [live],
      historySessions: [stored],
      archivedSessions: [archived],
      configOptions: { s1: [option] },
      contextUsage: { s3: { used: 1, window: 2 } },
    });
    expect(source.sessions).toEqual([live]);
    // The row landed in the list the caller named — which is the whole point of
    // the fixture for the three-list walk. Read `archived` off the ROW, not the
    // list element: `SessionConfigSource`'s lists are typed as the narrow
    // `SessionRow` (`sessionConfig.ts:8`), a `Pick` that has no `archived`.
    expect(source.archivedSessions).toEqual([archived]);
    expect(source.archivedSessions[0]?.sessionId).toBe("s3");
    expect(archived.archived).toBe(true);
    expect(source.configOptions.s1).toEqual([option]);
    expect(source.contextUsage.s3).toEqual({ used: 1, window: 2 });
  });
});

describe("subagent fixtures", () => {
  it("makeSubagentEntry defaults a RUNNING child (the state a started frame leaves)", () => {
    const entry: SubagentEntry = makeSubagentEntry();
    expect(entry.status).toBe("running");
    expect(entry.sessionId).toBeTruthy();
    expect(entry.parentSessionId).toBeTruthy();
    expect(entry.agentName).toBeTruthy();
    expect(entry.task).toBeTruthy();
    expect(typeof entry.startedAt).toBe("number");
    // A RUNNING child has no close stamp, no metrics and no failure code.
    expect("endedAt" in entry).toBe(false);
    expect("metrics" in entry).toBe(false);
    expect("reason" in entry).toBe(false);
  });

  it("makeSubagentEntry keeps the parent/child identity coherent under overrides", () => {
    const entry = makeSubagentEntry({ sessionId: "child-2" });
    // The default parent must not silently equal a overridden child id.
    expect(entry.parentSessionId).not.toBe(entry.sessionId);
    const closed = makeSubagentEntry({
      status: "completed",
      endedAt: 2000,
      metrics: { inputTokens: 1, outputTokens: 2, cost: 0.5, durationMs: 3 },
    });
    expect(closed.status).toBe("completed");
    expect(closed.metrics?.durationMs).toBe(3);
  });

  it("makeSubagentState keys entries by sessionId", () => {
    const state = makeSubagentState([
      makeSubagentEntry({ sessionId: "c1" }),
      makeSubagentEntry({ sessionId: "c2", parentSessionId: "p2" }),
    ]);
    expect(Object.keys(state.entries)).toEqual(["c1", "c2"]);
    expect(state.entries.c2?.parentSessionId).toBe("p2");
    expect(makeSubagentState().entries).toEqual({});
  });
});

describe("resetStores — the store half of the isolation", () => {
  /** Dirty EVERY store with a value no reset is allowed to leave behind. */
  function dirtyEveryStore(): void {
    useSessions.setState({
      sessions: [makeSessionRow({ sessionId: "dirty-live" })],
      historySessions: [makeSessionRow({ sessionId: "dirty-stored" })],
      archivedSessions: [makeSessionRow({ sessionId: "dirty-archived", archived: true })],
      activeSessionId: "dirty-live",
      activeSpacePath: "/w/dirty",
      spaces: [makeSpaceRow({ path: "/w/dirty" })],
      closeReasons: { "dirty-live": "user" },
      messages: { "dirty-live": [makeMessage("user", { text: "stale" })] },
      configOptions: { "dirty-live": [] },
      contextUsage: { "dirty-live": { used: 1, window: 1 } },
      compacting: { "dirty-live": "manual" },
      inTurn: { "dirty-live": true },
      stopReasons: { "dirty-live": "end_turn" },
      stalled: { "dirty-live": { at: 1, crashLog: null } },
      history: { "dirty-live": { oldestRowId: 1, hasMore: true, loadingMore: false, generation: 1, epoch: 1 } },
      newSessionError: "boom",
    });
    useSettings.getState().setSettings(makeSettings({ palette: "dracula" }));
    useSubagents.getState().addSession({
      sessionId: "child-dirty",
      parentSessionId: "dirty-live",
      agentName: "scout",
      task: "stale",
      status: "running",
    });
    useInteractive.getState().addRequest("dirty-live", {
      requestId: "r-dirty",
      method: "confirm",
      source: "native",
      params: { command: "ls", reason: "stale" },
    });
    useInteractive.getState().applyTodoUpdate("dirty-live", {
      todos: [{ id: "t1", content: "stale", status: "pending" }],
    });
    useSubagentSelection.getState().select("child-dirty");
    useQueuedPrompts.getState().enqueue("dirty-live", {
      id: "q1",
      text: "stale",
      attachments: [],
      state: "queued",
    });
    usePermissions.getState().addPrompt("dirty-live", "r-perm", {
      toolCall: { title: "stale" },
      options: [],
    });
  }

  /** Every store's data half, as the stores themselves define "fresh". */
  function snapshotStores(): unknown {
    return [
      useSessions.getState(),
      useSettings.getState(),
      useSubagents.getState(),
      useInteractive.getState(),
      useSubagentSelection.getState(),
      useQueuedPrompts.getState(),
      usePermissions.getState(),
    ];
  }

  it("the dirty step really dirties (a reset test on a clean store proves nothing)", () => {
    dirtyEveryStore();
    expect(useSessions.getState().activeSessionId).toBe("dirty-live");
    expect(useSettings.getState().settings?.palette).toBe("dracula");
    expect(Object.keys(useSubagents.getState().entries)).toEqual(["child-dirty"]);
    expect(useInteractive.getState().requests["dirty-live"]).toHaveLength(1);
    expect(useSubagentSelection.getState().selectedSessionId).toBe("child-dirty");
    expect(useQueuedPrompts.getState().bySession["dirty-live"]).toHaveLength(1);
    expect(usePermissions.getState().prompts["dirty-live"]).toHaveLength(1);
    resetStores();
  });

  it("leaves every store deep-equal to its own initial state (the shallow-merge catcher)", () => {
    dirtyEveryStore();
    resetStores();
    // `toEqual` over the WHOLE state object is the assertion that a partial
    // `setState({ sessions: [] })` cannot pass: `setState` shallow-merges, so a
    // reset that names some keys and not others leaves the rest of the dirty
    // slice standing, and the next test inherits a `messages` map it believes
    // is empty.
    expect(useSessions.getState()).toEqual(useSessions.getInitialState());
    expect(useSettings.getState()).toEqual(useSettings.getInitialState());
    expect(useSubagents.getState()).toEqual(useSubagents.getInitialState());
    expect(useInteractive.getState()).toEqual(useInteractive.getInitialState());
    expect(useSubagentSelection.getState()).toEqual(
      useSubagentSelection.getInitialState(),
    );
    expect(useQueuedPrompts.getState()).toEqual(
      useQueuedPrompts.getInitialState(),
    );
    expect(usePermissions.getState()).toEqual(usePermissions.getInitialState());
  });

  it("clears the dirtied keys individually (a named list, not only the whole-state compare)", () => {
    dirtyEveryStore();
    resetStores();
    const sessions = useSessions.getState();
    expect(sessions.sessions).toEqual([]);
    expect(sessions.historySessions).toEqual([]);
    expect(sessions.archivedSessions).toEqual([]);
    expect(sessions.activeSessionId).toBeNull();
    expect(sessions.activeSpacePath).toBeNull();
    expect(sessions.spaces).toEqual([]);
    expect(sessions.closeReasons).toEqual({});
    expect(sessions.messages).toEqual({});
    expect(sessions.configOptions).toEqual({});
    expect(sessions.contextUsage).toEqual({});
    expect(sessions.compacting).toEqual({});
    expect(sessions.inTurn).toEqual({});
    expect(sessions.stopReasons).toEqual({});
    expect(sessions.stalled).toEqual({});
    expect(sessions.history).toEqual({});
    expect(sessions.newSessionError).toBeNull();
    expect(useSettings.getState().settings).toBeNull();
    expect(useSettings.getState().loaded).toBe(false);
    expect(useSubagents.getState().entries).toEqual({});
    expect(useInteractive.getState().requests).toEqual({});
    expect(useInteractive.getState().todos).toEqual({});
    expect(useInteractive.getState().agentState).toEqual({});
    expect(useInteractive.getState().cost).toEqual({});
    expect(useInteractive.getState().session).toEqual({});
    expect(useSubagentSelection.getState().selectedSessionId).toBeNull();
    expect(useQueuedPrompts.getState().bySession).toEqual({});
    expect(usePermissions.getState().prompts).toEqual({});
  });

  it("keeps the store ACTIONS callable after a reset (a replace must not drop them)", () => {
    dirtyEveryStore();
    resetStores();
    // A reset implemented by `setState({}, true)` would pass the emptiness
    // assertions above and leave every component calling a missing action.
    expect(typeof useSessions.getState().addSession).toBe("function");
    expect(typeof useSessions.getState().applySessionUpdate).toBe("function");
    expect(typeof useSettings.getState().setSettings).toBe("function");
    expect(typeof useSubagents.getState().markClosed).toBe("function");
    expect(typeof useInteractive.getState().dismissSession).toBe("function");
    expect(typeof useSubagentSelection.getState().select).toBe("function");
    expect(typeof useQueuedPrompts.getState().takeHead).toBe("function");
    expect(typeof usePermissions.getState().removePrompt).toBe("function");
    // And they still WORK: the store is live, not a frozen snapshot.
    useSessions.getState().addSession(makeSessionRow({ sessionId: "after-reset" }));
    expect(useSessions.getState().activeSessionId).toBe("after-reset");
    resetStores();
  });

  it("is idempotent (a double reset is not an error, and cannot re-dirty)", () => {
    resetStores();
    const before = snapshotStores();
    resetStores();
    expect(snapshotStores()).toEqual(before);
  });

  it("does NOT reset src/store/sessions.ts's module-scope message-id counter (naming the limit)", () => {
    // `clientMessageSeq` (`src/store/sessions.ts:620`) is a module `let`, not
    // store state — `resetStores()` CANNOT reach it, and this test pins that so
    // the helper's name never promises full isolation. A test that needs the
    // counter itself must get a named reset exported from the store; until then
    // the honest claim is: STORES are reset, module state is not.
    useSessions.getState().addUserMessage("s", "one");
    useSessions.getState().addSystemLine("s", "first client line");
    const before = useSessions.getState().messages["s"] ?? [];
    const idBefore = before[before.length - 1];
    expect(idBefore?.kind).toBe("agent-text");
    const seqBefore = Number(
      (idBefore as { messageId: string }).messageId.split(":")[1],
    );
    resetStores();
    expect(useSessions.getState().messages).toEqual({});
    useSessions.getState().addUserMessage("s", "two");
    useSessions.getState().addSystemLine("s", "second client line");
    const after = useSessions.getState().messages["s"] ?? [];
    const idAfter = after[after.length - 1] as { messageId: string };
    expect(Number(idAfter.messageId.split(":")[1])).toBeGreaterThan(seqBefore);
    resetStores();
  });
});

describe("resetModuleFlags — the module-scope half, named for what it touches", () => {
  it("restores the three module flags to the values they had at import", () => {
    // The pane flags seed themselves from localStorage at import, so the value
    // to restore to is whatever they held when the seam loaded — NOT `false`
    // (a file that ran with a persisted `true` would fail a `toBe(false)`).
    const leftAtImport = getLeftPaneCollapsed();
    const sideAtImport = getSidePaneCollapsed();
    setLeftPaneCollapsed(!leftAtImport);
    setSidePaneCollapsed(!sideAtImport);
    setNewSpaceDialogOpen(true);
    expect(getLeftPaneCollapsed()).toBe(!leftAtImport);
    expect(getSidePaneCollapsed()).toBe(!sideAtImport);
    expect(getNewSpaceDialogOpen()).toBe(true);
    resetModuleFlags();
    expect(getLeftPaneCollapsed()).toBe(leftAtImport);
    expect(getSidePaneCollapsed()).toBe(sideAtImport);
    expect(getNewSpaceDialogOpen()).toBe(false);
  });

  it("leaves the pane persistence agreeing with the restored flag", () => {
    setLeftPaneCollapsed(true);
    setSidePaneCollapsed(true);
    resetModuleFlags();
    // The modules own their own persistence; a reset that flipped the flag
    // without the write would leave localStorage and memory disagreeing for
    // every later file in the worker.
    expect(localStorage.getItem("left-pane-collapse")).toBe(
      String(getLeftPaneCollapsed()),
    );
    expect(localStorage.getItem("side-pane-collapse")).toBe(
      String(getSidePaneCollapsed()),
    );
  });
});

describe("the seam is usable from inside a hoisted vi.mock factory", () => {
  it("await import() inside the factory reaches the fixture (the SpacesList.test.tsx:100-104 blocker)", () => {
    // `getSettings` is mocked ABOVE, by a factory that pulls `makeSettings` in
    // with `await import()` — so a resolved value here proves the fixture is
    // reachable from a hoisted factory, which is exactly what the per-file
    // `const SETTINGS_FIXTURE` pattern cannot do (a hoisted factory touching an
    // outer const throws in the TDZ, which is why 25 files inline the literal).
    let reached: AppSettings | undefined;
    void getSettings().then((settings) => {
      reached = settings;
    });
    return getSettings().then((settings) => {
      expect(reached).toBeDefined();
      expect(Object.keys(settings).sort()).toEqual(APP_SETTINGS_FIELDS);
    });
  });
});
