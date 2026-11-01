/**
 * `ChatStream` — the child-gate groups (issue #135 §5, task06).
 *
 * These 16 tests were MOVED VERBATIM out of `src/components/ChatStream.test.tsx`:
 * the two adjacent describes `describe("ChatStream (a child gate renders inline
 * in the PARENT's transcript)")` (13, with its locals `childEntry`, `askChild`,
 * `askRequestPayload`) and `describe("ChatStream (a child gate scrolls into
 * view)")` (3, with its locals `FAKE_SCROLL_HEIGHT`, `watchScrollWrites`). They
 * share ONE scaffold copy because they are one domain — the inline half of the
 * child-gate render-site partition owned by `src/hooks/useChildGates.ts` plus
 * this component's inline rendering (`SubagentModals` keeps the overlay half).
 * `it` titles and assertion bodies are byte-identical to the residual's; nothing
 * was added, removed or improved.
 *
 * WHAT STAYED in `ChatStream.test.tsx`: the `ChatStream` integration describe
 * and the four attachment/queue integration groups — plus the out-of-Space
 * Directory completion group, which lives in
 * `src/components/ChatStreamDirectoryCompletion.test.tsx`.
 *
 * WHY the `vi.mock` factories are INLINE here and not delegated to
 * `src/test/chatStreamFixtures.ts`: that module imports `useSessions` /
 * `useSettings`, whose stores import `../lib/tauri`, so it HAS a transitive path
 * into the mocked barrel, and a factory body may reference only bindings from a
 * module free of that path — a delegation fails as 0 tests run with
 * `Cannot access '__vi_import_N__' before initialization` (measured; the probe
 * matrix in `docs/roadmap/chatstream-decomposition-ground-chat-test-scaffolding.md`).
 * Both factories below therefore touch nothing but `vi` and their own
 * `vi.importActual` result, and the fixtures import stays AFTER the `ChatStream`
 * import. This file is therefore the second of the two new mockers the mock-seam
 * pin in `src/lib/tauriBarrel.test.ts` counts.
 */

import { beforeEach, describe, expect, it, vi, beforeAll } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import ChatStream from "./ChatStream";
import { cancelSession, respondInteractiveRequest, respondPermission } from "../lib/tauri";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import { clearMentionCatalogsCache } from "../hooks/useMentionCatalogs";
import { setSidePaneCollapsed } from "../lib/sidePaneState";
import { useQueuedPrompts } from "../store/queuedPrompts";
import { useSessions } from "../store/sessions";
import { useInteractive } from "../store/interactive";
import { useSubagents } from "../store/subagents";
import { usePermissions } from "../store/permissions";
import { seedLiveSession } from "../test/chatStreamFixtures";
import { resetStores } from "../test/resetStores";

// The environment stubs `src/test/setup.tsx` does NOT provide.
//
// DELETED here by the rolling B4a migration (this file was touched by B2 for the
// `IPC_EVENTS.insertSkill` fold): the `matchMedia` `stubGlobal`, the four
// `Element.prototype` pointer-capture/`scrollIntoView` stubs. All five are
// byte-equivalent to what `setup.tsx`'s own `beforeAll` installs, and this file
// calls no `vi.unstubAllGlobals()`, so the shared stubs survive for the whole
// file (that call is the ONLY thing that strips a setup-file `stubGlobal` — see
// the guard list in `setup.tsx`).
//
// KEPT, and neither is redundancy:
//  - the object-URL pair: `setup.tsx` stubs no `URL` API, and staged
//    attachments need a deterministic `blob:` URL (Node's global `URL` reaches
//    jsdom but rejects web `Blob`s).
//  - the THREE `HTMLElement.prototype` stubs: `setup.tsx` puts `scrollIntoView`
//    on `Element.prototype` only, and two tests below read
//    `HTMLElement.prototype.scrollIntoView` directly and inspect
//    `mock.contexts` to learn WHICH picker row scrolled. Without this own-property
//    override that read is `undefined` and the calls land on the inherited
//    `Element` stub — so this is a dependency, not a duplicate.
beforeAll(() => {
  URL.createObjectURL = vi.fn((file: File) => `blob:mock-${file.name}`);
  URL.revokeObjectURL = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});

// Mock the Tauri IPC layer; everything else (stores) is the real code.
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    startSession: vi.fn().mockResolvedValue({
      sessionId: "s2",
      cwd: "/home/u/proj",
      capabilities: {},
      archived: false,
    }),
    closeSession: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn().mockResolvedValue("end_turn"),
    resumeSession: vi.fn().mockResolvedValue({
      sessionId: "s1",
      cwd: "/home/u/proj",
      capabilities: { loadSession: true, promptCapabilities: { image: true } },
      archived: false,
    }),
    respondPermission: vi.fn().mockResolvedValue(undefined),
    respondInteractiveRequest: vi.fn().mockResolvedValue(undefined),
    setSessionConfigOption: vi.fn().mockResolvedValue([]),
    readClipboardImage: vi.fn().mockResolvedValue(null),
    readFileBytes: vi.fn().mockResolvedValue(null),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    // The `/compact` Composer command (ADR 0044). MOCKED ON PURPOSE, and not
    // optional: this factory spreads `importActual`, so an un-mocked
    // `compactSession` would reach the REAL `invoke` and reject on jsdom's
    // missing `window.__TAURI_INTERNALS__` — a dispatch test would then "pass"
    // on the rejection landing in `send()`'s `catch` rather than on the
    // interception. `true` = "the frame was written" (the live answer).
    compactSession: vi.fn().mockResolvedValue(true),
    loadHistory: vi.fn().mockResolvedValue({ rows: [], hasMore: false, todos: null }),
    listSkills: vi.fn().mockResolvedValue([
      {
        name: "debug",
        description: "Debug a failure",
        path: "/s/.agents/skills/debug/SKILL.md",
        dir: "/s/.agents/skills/debug",
        scope: "space",
        body: "Step 1. Step 2.",
        shadowed: [],
      },
      {
        name: "beta",
        description: "Beta skill",
        path: "/s/.agents/skills/beta/SKILL.md",
        dir: "/s/.agents/skills/beta",
        scope: "space",
        body: "B body",
        shadowed: [],
      },
    ]),
    listAgentDefinitionsForSpace: vi.fn().mockResolvedValue([
      {
        name: "scout",
        description: "Fast recon.",
        model: null,
        scope: "user",
      },
    ]),
    listMcpServersEffective: vi.fn().mockResolvedValue([
      {
        name: "postgres",
        kind: "stdio",
        summary: "npx -y x-mcp",
      },
    ]),
    // The `?` File-completion listing (ADR 0033). Mocked because EVERY
    // session-mounting test in this file calls it (the catalog hook fetches
    // unconditionally), and the `?` tests need to control the payload per
    // test — including a DEFERRED promise for the in-flight case. Empty by
    // default so the pre-existing `$`/`@`/`#` tests see no file rows.
    listSpaceListing: vi.fn().mockResolvedValue({ entries: [], truncated: false }),
    // The out-of-Space Directory completion rows (ADR 0035). Mocked for the
    // same reason as `listSpaceListing`, and it is NOT optional: the composer
    // calls `useCompletionDir(null)` on EVERY mount (an empty draft has no
    // token, so `dirPrefix` is `null` and the cache misses), so an un-mocked
    // export — this factory spreads `importActual` — would fire a REAL
    // `invoke` in jsdom, reject on the missing `window.__TAURI_INTERNALS__`
    // and log a `listCompletionEntries failed:` line in every
    // session-mounting test in this file.
    listCompletionEntries: vi.fn().mockResolvedValue({
      entries: [],
      truncated: false,
    }),
  };
});

// The native file picker (the `+` button's `open` — the real module would
// `invoke` Tauri's dialog plugin, which doesn't exist in jsdom).
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

beforeEach(() => {
  // Restore real timers in case a previous test installed fake ones (the
  // mid-read tests below use `vi.useFakeTimers()` to settle the macrotask-
  // based `FileReader` deterministically) — a no-op for tests that don't.
  vi.useRealTimers();
  setSidePaneCollapsed(false);
  localStorage.clear();
  // The prompt queue is a module singleton too — drop every entry so a queue
  // left by the previous test cannot satisfy a "nothing was queued" assertion.
  // BEFORE `clearAllMocks` so the URL releases this cleanup performs are not
  // counted against the revocation assertions in the queue tests.
  for (const id of Object.keys(useQueuedPrompts.getState().bySession)) {
    useQueuedPrompts.getState().clearSession(id);
  }
  // `clearAllMocks` clears the call history (the `URL` stub implementations
  // from `beforeAll` survive — `mockClear` semantics, not `mockReset`).
  vi.clearAllMocks();
  // The skill catalog's module-level cache is shared across tests in this
  // file — clear it so each test starts with a COLD cache (a warm cache from
  // a previous test's `seedLiveSession` `cwd` key would make the fresh
  // `listSkills` mock moot: the hook would serve the cached value and never
  // re-fetch).
  clearSkillCatalogCache();
  clearMentionCatalogsCache();
  // Every store back to zustand's own captured initial state (the rolling
  // migration). This replaces a hand-written 11-key `useSessions` reset — the
  // store carries data fields that list never named, so `history`,
  // `contextUsage`, `stalled`, `newSessionError` and friends used to leak from
  // one test to the next — plus the per-id `dismiss*` calls (a whole-store
  // replace already covers them) and the settings reset (whose values ARE the
  // initial state). No count of the store's data fields is quoted here on
  // purpose: it goes stale the moment a field is added, and this comment would
  // then be a confident lie about the store it is explaining.
  //
  // The queued-prompt loop ABOVE still runs first and is NOT redundant: its
  // `clearSession` releases staged object URLs, a side effect a state replace
  // cannot perform.
  resetStores();
});

describe("ChatStream (a child gate renders inline in the PARENT's transcript)", () => {
  // The INLINE half of the render-site partition: the parent is on screen, so
  // its child's `ask` / Permission prompt
  // answer WHERE THE USER IS ALREADY LOOKING — at the bottom of the parent's
  // transcript, labelled with the child's `agentName`. `SubagentModals` keeps
  // the gates this component structurally cannot render (its parent is not the
  // active session — `ChatStream` reads only `activeSessionId`) plus every
  // child's `confirm`/`password` (Radix `Dialog`s, modal by nature).
  const childEntry = {
    sessionId: "sub1",
    parentSessionId: "s1",
    agentName: "reviewer",
    task: "review the diff",
    status: "running" as const,
  };
  const askChild = (question = "Which color?") => {
    useSubagents.getState().addSession(childEntry);
    useInteractive.getState().addRequest("sub1", askRequestPayload("r1", question));
  };
  /** One pending `ask` payload (the shape `AskQuestionCard` renders). */
  const askRequestPayload = (requestId: string, question: string) => ({
    requestId,
    method: "ask" as const,
    source: "subagent:reviewer",
    params: {
      questions: [
        { id: "q1", question, options: [{ label: "Red" }, { label: "Blue" }] },
      ],
    },
  });

  it("renders a child's pending `ask` in the parent's transcript, labelled with the child's name", () => {
    seedLiveSession();
    askChild();
    render(<ChatStream />);
    const scroll = document.querySelector('[data-testid="transcript-scroll"]')!;
    // The card is IN THE TRANSCRIPT (not only in the overlay — this file
    // renders `ChatStream` alone, so nothing else could have drawn it).
    expect(scroll.textContent).toContain("Which color?");
    expect(screen.getByRole("button", { name: "Red" })).toBeTruthy();
    // The attribution chip lives on MessageList's WRAPPER, not inside the card
    // (the card components stay parent/child agnostic and are reused unchanged
    // by the main chat).
    expect(scroll.textContent).toContain("↳ reviewer");
  });

  it("an inline child `ask` does NOT steal focus from the composer", () => {
    // A child's `ask` can land at ANY moment — including while the user is
    // mid-sentence in the composer. A lifted card is never anchored (its
    // `source` is `subagent:<name>`), so `AskQuestionCard`'s unanchored
    // auto-focus would fire on every one of them: focus jumps to a
    // `tabIndex={-1}` div, the remaining keystrokes are LOST, and Enter no
    // longer sends. The card therefore mounts with `autoFocus={false}` here.
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    textarea.focus();
    expect(document.activeElement).toBe(textarea);
    act(() => {
      askChild();
    });
    // The card IS there (the gate is rendered — it just does not take focus).
    expect(screen.getByText("Which color?")).toBeTruthy();
    expect(document.activeElement).toBe(textarea);
  });

  it("the inline card answers the CHILD's session id (never the parent's)", async () => {
    seedLiveSession();
    askChild();
    render(<ChatStream />);
    fireEvent.click(screen.getByRole("button", { name: "Red" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await act(async () => {
      await Promise.resolve();
    });
    // The Supervisor re-emits a child's request with the CHILD's `sessionId`,
    // and `respond_interactive_request` routes on it — answering "s1" here
    // would answer nothing and strand the child.
    expect(vi.mocked(respondInteractiveRequest)).toHaveBeenCalledWith(
      "sub1",
      "r1",
      expect.anything(),
    );
    const firstCall = vi.mocked(respondInteractiveRequest).mock.calls[0]!;
    expect(firstCall[0]).not.toBe("s1");
    expect(useInteractive.getState().requests["sub1"]).toHaveLength(0);
  });

  it("renders a child's Permission prompt in the parent's transcript, labelled, and answers the child", async () => {
    seedLiveSession();
    useSubagents.getState().addSession(childEntry);
    act(() => {
      usePermissions.getState().addPrompt("sub1", "p1", {
        toolCall: { title: "Bash (apt install ripgrep)" },
        options: [{ optionId: "allow", name: "Allow" }],
      });
    });
    render(<ChatStream />);
    const scroll = document.querySelector('[data-testid="transcript-scroll"]')!;
    expect(scroll.textContent).toContain("Bash (apt install ripgrep)");
    expect(scroll.textContent).toContain("↳ reviewer");
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(respondPermission)).toHaveBeenCalledWith(
      "sub1",
      "p1",
      expect.anything(),
    );
  });

  it("an Escape on the inline child-gate row does NOT cancel the PARENT's turn", async () => {
    // `ChatStream`'s "Esc stops inference" listener is WINDOW-level and active
    // while `inTurn`. The overlay protects itself with an Escape stop; the
    // inline row needs the same one, or an Esc that lands on the row (or on a
    // `PermissionPrompt` button, which has no Esc handler at all) kills the
    // PARENT's turn while the child's question sits unanswered in that very
    // transcript. Finding 1 makes this the NORMAL case: the card no longer
    // takes focus on mount, so focus is routinely OUTSIDE it.
    seedLiveSession();
    askChild();
    render(<ChatStream />);
    useSessions.getState().beginTurn("s1");
    await act(async () => {});
    const row = screen.getByText("↳ reviewer").parentElement!;
    await act(async () => {
      fireEvent.keyDown(row, { key: "Escape" });
    });
    expect(vi.mocked(cancelSession)).not.toHaveBeenCalled();
    // Non-dismissible: the gate stays pending.
    expect(screen.getByText("Which color?")).toBeTruthy();
    expect(useInteractive.getState().requests["sub1"]).toHaveLength(1);
  });

  it("an Escape on a child Permission prompt does NOT cancel the PARENT's turn", async () => {
    // `PermissionPrompt` carries no `onKeyDown` of its own, so the row wrapper
    // is the only thing between its buttons and the window listener.
    seedLiveSession();
    useSubagents.getState().addSession(childEntry);
    act(() => {
      usePermissions.getState().addPrompt("sub1", "p1", {
        toolCall: { title: "Bash (apt install ripgrep)" },
        options: [{ optionId: "allow", name: "Allow" }],
      });
    });
    render(<ChatStream />);
    useSessions.getState().beginTurn("s1");
    await act(async () => {});
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("button", { name: "Allow" }), {
        key: "Escape",
      });
    });
    expect(vi.mocked(cancelSession)).not.toHaveBeenCalled();
    expect(screen.getByText("Bash (apt install ripgrep)")).toBeTruthy();
  });

  it("an Escape INSIDE the inline child card answers the CHILD and does NOT cancel the parent", async () => {
    // Re-hosts the guarantee the retired `SubagentDetailHost` test used to pin
    // (an Esc consumed by a nested `AskQuestionCard` must not reach anything
    // else): React runs the INNERMOST handler first and the card's
    // `stopPropagation()` reaches `nativeEvent.stopPropagation()`, so the row
    // wrapper's stop never runs for a card that handles Esc itself — the card
    // is dismissed and the parent's turn survives.
    seedLiveSession();
    askChild();
    render(<ChatStream />);
    useSessions.getState().beginTurn("s1");
    await act(async () => {});
    const card = screen
      .getByText("Which color?")
      .closest("[tabindex='-1']")!;
    await act(async () => {
      fireEvent.keyDown(card, { key: "Escape" });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(respondInteractiveRequest)).toHaveBeenCalledWith(
      "sub1",
      "r1",
      expect.anything(),
    );
    expect(vi.mocked(cancelSession)).not.toHaveBeenCalled();
  });

  it("renders the child's cards BELOW the parent's own stacked card", () => {
    seedLiveSession();
    // The parent's own unanchored `ask` (the stacked block).
    useInteractive.getState().addRequest("s1", {
      requestId: "parent-ask",
      method: "ask",
      source: "main",
      params: {
        questions: [
          { id: "q1", question: "Parent question?", options: [{ label: "A" }] },
        ],
      },
    });
    askChild();
    render(<ChatStream />);
    const scroll = document.querySelector(
      '[data-testid="transcript-scroll"]',
    ) as HTMLElement;
    const text = scroll.textContent!;
    expect(text).toContain("Parent question?");
    expect(text).toContain("Which color?");
    // ORDER: the parent's own card first, the child's gate after it.
    expect(text.indexOf("Parent question?")).toBeLessThan(
      text.indexOf("Which color?"),
    );
  });

  it("does NOT render a child's `confirm`/`password` inline (they stay overlay `Dialog`s)", () => {
    seedLiveSession();
    useSubagents.getState().addSession(childEntry);
    useInteractive.getState().addRequest("sub1", {
      requestId: "r2",
      method: "confirm",
      source: "subagent:reviewer",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    useInteractive.getState().addRequest("sub1", {
      requestId: "r3",
      method: "password",
      source: "subagent:reviewer",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    render(<ChatStream />);
    const scroll = document.querySelector(
      '[data-testid="transcript-scroll"]',
    ) as HTMLElement;
    // `ComposerModals` renders the ACTIVE session's sudo modals; a CHILD's
    // sudo request must not leak into the parent's transcript (nor a `Dialog`
    // into the scroll region) — `SubagentModals` hosts those for every child.
    expect(scroll.textContent).not.toContain("sudo");
    expect(scroll.textContent).not.toContain("Sudo password required");
    expect(screen.queryByText("Run this command with sudo?")).toBeNull();
  });

  it("renders TWO distinct inline cards when two children of the ACTIVE parent share a gateway `requestId`", () => {
    // The inline half of the composite-key regression `SubagentModals.test.tsx`
    // pins for the overlay. A child's `requestId` is the model's tool-call id,
    // which some OpenAI-compatible gateways index per response (`call_0`), so
    // the same id DOES recur across siblings of one parent — and this is the
    // surface the whole feature exists to serve, so it needs its own pin.
    // A bare-`requestId` key makes React drop one of the two rows: a dropped
    // card is a gate that renders NOWHERE and strands the child INDEFINITELY
    // (ADR 0055: a gate-parked child is an Active Subagent, so no clock ends it).
    seedLiveSession();
    useSubagents.getState().addSession(childEntry);
    useSubagents.getState().addSession({
      ...childEntry,
      sessionId: "sub2",
      agentName: "explorer",
      task: "explore the codebase",
    });
    useInteractive.getState().addRequest("sub1", askRequestPayload("call_0", "Which color?"));
    useInteractive.getState().addRequest("sub2", askRequestPayload("call_0", "Which path?"));
    // The warning is what actually bites: both cards can render while React
    // still logs the collision (and the duplicate key is the bug whether or not
    // this jsdom build happens to drop a row), so the pin watches `console.error`
    // as well as the DOM.
    const keyWarnings: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      keyWarnings.push(args.map(String).join(" "));
    };
    try {
      render(<ChatStream />);
    } finally {
      console.error = originalError;
    }
    const scroll = document.querySelector('[data-testid="transcript-scroll"]')!;
    // Both questions AND both attributions are in the PARENT's transcript.
    expect(scroll.textContent).toContain("Which color?");
    expect(scroll.textContent).toContain("Which path?");
    expect(scroll.textContent).toContain("↳ reviewer");
    expect(scroll.textContent).toContain("↳ explorer");
    expect(screen.getAllByRole("button", { name: "Red" })).toHaveLength(2);
    expect(
      keyWarnings.filter((m) => /same key/i.test(m)),
      keyWarnings.join("\n"),
    ).toEqual([]);
  });

  it("renders NOTHING inline for a child whose parent is NOT the active session", () => {
    seedLiveSession();
    // The child belongs to another Session — `ChatStream` renders only the
    // active one, and `SubagentModals` owns this gate (the never-nowhere half
    // of the partition).
    useSubagents.getState().addSession({ ...childEntry, parentSessionId: "other" });
    useInteractive.getState().addRequest("sub1", {
      requestId: "r1",
      method: "ask",
      source: "subagent:reviewer",
      params: {
        questions: [
          { id: "q1", question: "Which color?", options: [{ label: "Red" }] },
        ],
      },
    });
    render(<ChatStream />);
    expect(screen.queryByText("Which color?")).toBeNull();
    // The hint IS suppressed anyway, and NOT by this Session's gates:
    // `hasPendingRequest` ORs `usePendingSubagentRequests`, whose count is
    // app-wide on purpose (see its doc). Recorded so this test never reads as a
    // parent-scoped hint rule.
    expect(screen.queryByText("Send a prompt to start")).toBeNull();
  });

  it("suppresses the fresh-session hint while a child gate is pending inline", () => {
    // The empty transcript must not swallow the card (`hasPendingRequest`
    // already ORs `pendingSubagentRequests > 0` — pinned here so a future
    // "simplification" of that line cannot silently re-introduce the swallow).
    seedLiveSession();
    askChild();
    render(<ChatStream />);
    expect(screen.queryByText("Send a prompt to start")).toBeNull();
  });

  it("survives no-session → active-session WITH a pending child gate (the hook sits before the early return)", () => {
    // `useChildGates` contains `useSyncExternalStore` (via zustand), so it MUST
    // be called unconditionally before the `!activeSessionId` early return —
    // calling it only on the full-frame path changes the hook count when the
    // active session appears and crashes React (white page). The same trap
    // `usePendingSubagentRequests` documents.
    render(<ChatStream />);
    expect(
      screen.getByText("No active session — open a Space from the tabs above"),
    ).toBeTruthy();
    act(() => {
      seedLiveSession();
      askChild();
    });
    expect(screen.getByText("Which color?")).toBeTruthy();
  });
});

describe("ChatStream (a child gate scrolls into view)", () => {
  /** jsdom has no layout, so "scrolled to the bottom" is observable ONLY
   * through the `scrollTop` WRITE — and in jsdom `scrollHeight` is `0`, which
   * would make "the effect assigned `scrollHeight`" true of a write of `0` (and
   * of a write to nowhere). Both are therefore faked: a non-zero content height
   * and a recorder for the value written. */
  const FAKE_SCROLL_HEIGHT = 1234;

  /** Watch the auto-scroll. Returns the live counter plus the value of the
   * MOST RECENT write (call `reset()` after `render` — its own mount write is
   * not the thing under test). */
  function watchScrollWrites(): {
    writes: () => number;
    lastValue: () => number | undefined;
    reset: () => void;
  } {
    const scroll = document.querySelector(
      '[data-testid="transcript-scroll"]',
    ) as HTMLElement;
    Object.defineProperty(scroll, "scrollHeight", {
      configurable: true,
      get: () => FAKE_SCROLL_HEIGHT,
    });
    const state = { n: 0, last: undefined as number | undefined };
    Object.defineProperty(scroll, "scrollTop", {
      configurable: true,
      get: () => 0,
      set: (v: number) => {
        state.n += 1;
        state.last = v;
      },
    });
    return {
      writes: () => state.n,
      lastValue: () => state.last,
      reset: () => {
        state.n = 0;
        state.last = undefined;
      },
    };
  }

  it("re-scrolls the transcript when a child gate arrives (the card is at the BOTTOM)", () => {
    // The inline gate renders at the END of the scroll region, so a transcript
    // the user has scrolled up in would hide the very card they must answer —
    // the same reason `prompts.length`/`stackedAskRequests.length` are
    // auto-scroll deps. jsdom has no layout, so the assertion watches the
    // `scrollTop` WRITE (the effect's only observable effect).
    seedLiveSession();
    render(<ChatStream />);
    const scroll = watchScrollWrites();
    scroll.reset();
    // A gate for ANOTHER parent is not this transcript's business: nothing
    // arrives here, so nothing scrolls.
    act(() => {
      useSubagents.getState().addSession({
        sessionId: "sub1",
        parentSessionId: "other",
        agentName: "reviewer",
        task: "review the diff",
        status: "running",
      });
    });
    expect(scroll.writes()).toBe(0);
    // Re-parent the child to the active session → one gate appears inline →
    // the transcript scrolls to it.
    act(() => {
      useSubagents.getState().addSession({
        sessionId: "sub1",
        parentSessionId: "s1",
        agentName: "reviewer",
        task: "review the diff",
        status: "running",
      });
      useInteractive.getState().addRequest("sub1", {
        requestId: "r1",
        method: "ask",
        source: "subagent:reviewer",
        params: {
          questions: [
            { id: "q1", question: "Which color?", options: [{ label: "Red" }] },
          ],
        },
      });
    });
    expect(screen.getByText("Which color?")).toBeTruthy();
    expect(scroll.writes()).toBeGreaterThan(0);
    // Not merely "someone wrote `scrollTop`": the write must be to the BOTTOM,
    // i.e. the value the effect assigned IS the region's `scrollHeight`. A
    // write of any smaller number leaves the very question the user must answer
    // below the fold, and a count-only assertion cannot see that.
    expect(scroll.lastValue()).toBe(FAKE_SCROLL_HEIGHT);
    expect(scroll.lastValue()).toBe(
      document.querySelector('[data-testid="transcript-scroll"]')!.scrollHeight,
    );
  });

  it("does NOT scroll for a child's `confirm` of the ACTIVE parent (it renders in the overlay, not here)", () => {
    // The scroll dep must count the gates that actually render INLINE, not the
    // whole gate list: `confirm`/`password` are Radix `Dialog`s owned by
    // `SubagentModals`, so no row appears in this transcript and yanking the
    // user to the bottom for one is a scroll for a row that does not exist.
    seedLiveSession();
    render(<ChatStream />);
    const scroll = watchScrollWrites();
    scroll.reset();
    act(() => {
      useSubagents.getState().addSession({
        sessionId: "sub1",
        parentSessionId: "s1",
        agentName: "reviewer",
        task: "review the diff",
        status: "running",
      });
      useInteractive.getState().addRequest("sub1", {
        requestId: "r2",
        method: "confirm",
        source: "subagent:reviewer",
        params: { command: "apt install ripgrep", reason: "install the tool" },
      });
    });
    // The gate IS this parent's (so the filter is about the KIND, not the
    // parent), and it renders nowhere in the transcript.
    expect(screen.queryByText("Run this command with sudo?")).toBeNull();
    expect(scroll.writes()).toBe(0);
  });

  it("renders an inline child gate card in the transcript when messages are seeded (Virtuoso branch)", () => {
    seedLiveSession();
    useSessions.setState({
      messages: {
        s1: [{ kind: "user", text: "hello from user", at: 1 }],
      },
    });
    render(<ChatStream />);
    act(() => {
      useSubagents.getState().addSession({
        sessionId: "sub1",
        parentSessionId: "s1",
        agentName: "reviewer",
        task: "review the diff",
        status: "running",
      });
      useInteractive.getState().addRequest("sub1", {
        requestId: "r1",
        method: "ask",
        source: "subagent:reviewer",
        params: {
          questions: [
            { id: "q1", question: "Which color?", options: [{ label: "Red" }] },
          ],
        },
      });
    });
    expect(screen.getByText("hello from user")).toBeTruthy();
    expect(screen.getByText("Which color?")).toBeTruthy();
  });
});
