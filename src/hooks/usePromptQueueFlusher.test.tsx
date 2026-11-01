import { beforeEach, describe, expect, it, vi, beforeAll } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, type RefObject } from "react";
import ChatStream from "../components/ChatStream";
import { sendPrompt, listSkills, type StopReason } from "../lib/tauri";
import { useSessions } from "../store/sessions";
import { useQueuedPrompts } from "../store/queuedPrompts";
import { setSidePaneCollapsed } from "../lib/sidePaneState";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import { clearMentionCatalogsCache } from "../hooks/useMentionCatalogs";
import { resetStores } from "../test/resetStores";
import * as chatAttachments from "../lib/chatAttachments";
import type { ChatComposerAttachment } from "../lib/chatAttachments";
import {
  seedLiveSession,
  seedLiveSessionWithImages,
  flush,
  deferred,
  waitForCatalog,
} from "../test/chatStreamFixtures";
import { usePromptQueueFlusher } from "./usePromptQueueFlusher";
import type { UseChatPromptDispatchResult } from "./useChatPromptDispatch";

/**
 * `usePromptQueueFlusher` — the **Prompt queue**'s **Flush** (issue #135 §2).
 *
 * The group below was MOVED VERBATIM out of `src/components/ChatStream.test.tsx`
 * alongside `flushHead` and the render-phase `flushRef.current` assignment (13
 * tests + the group's four local helpers). `it` titles and assertion bodies are
 * unchanged; the only edits are the `describe` title (it now names its owning
 * hook) and this file's module shape. The tests KEEP rendering the real
 * `<ChatStream />` — the **Flush** is a wiring contract (the idle edge → the ref
 * → `flushHead` → `sendText`), and only the real component can prove it.
 *
 * WHAT STAYED in `ChatStream.test.tsx` on purpose: the two queue-ROWS placement
 * pins that never touch the **Flush** stay where their siblings are, and the
 * dispatch-side groups (`/compact`, the locked fork) moved to
 * `useChatPromptDispatch.test.tsx` with `send` / `sendText`. The failed-send
 * restore group and the `"double-send is guarded by sendingRef"` pin (THE one-Set
 * proof) also stay — they drive the real component through both hooks.
 *
 * WHY the `vi.mock` factories are INLINE here and not delegated to
 * `src/test/chatStreamFixtures.ts`: that module imports `useSessions` /
 * `useSettings`, whose stores import `../lib/tauri`, so it HAS a transitive path
 * into the mocked barrel, and a factory body may reference only bindings from a
 * module free of that path — a delegation fails as 0 tests run with
 * `Cannot access '__vi_import_N__' before initialization` (measured; the probe
 * matrix in `docs/roadmap/chatstream-decomposition-ground-chat-test-scaffolding.md`).
 * Both factories below therefore touch nothing but `vi` and their own
 * `vi.importActual` result. The fixtures module IS used BELOW the factories
 * (seeds, `flush`, `deferred`, `waitForCatalog`) — that is the documented, safe side.
 */

// The environment stubs `src/test/setup.tsx` does NOT provide (moved verbatim
// with the tests that need them).
//
// KEPT, and neither is redundancy:
//  - the object-URL pair: `setup.tsx` stubs no `URL` API, and staged
//    attachments need a deterministic `blob:` URL (Node's global `URL` reaches
//    jsdom but rejects web `Blob`s) — and the Flush tests below assert BOTH
//    directions of it (`revokeObjectURL` called for a dispatched entry's
//    preview, NOT called for a read that failed before any send).
//  - the THREE `HTMLElement.prototype` stubs: `setup.tsx` puts `scrollIntoView`
//    on `Element.prototype` only, and the moved tests read
//    `HTMLElement.prototype.scrollIntoView` directly and inspect
//    `mock.contexts` to learn WHICH element scrolled. Without this own-property
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
  // file — clear it so each test starts with a COLD cache (a warm cache from a
  // previous test's `seedLiveSession` `cwd` key would make the fresh
  // `listSkills` mock moot: the hook would serve the cached value and never
  // re-fetch).
  clearSkillCatalogCache();
  clearMentionCatalogsCache();
  // Every store back to zustand's own captured initial state. A hook test that
  // reaches a store must reset it — the suite never runs shuffled and
  // order-dependent store leakage is the documented failure mode.
  resetStores();
});

describe("usePromptQueueFlusher — the Flush: the queue drains when the Session goes idle", () => {
  /** The rendered queue rows, top of the stack first. */
  function queue(sessionId = "s1") {
    return useQueuedPrompts.getState().bySession[sessionId] ?? [];
  }

  /** Put an entry in the queue the way `send()`' fork does (raw text, no IPC). */
  function enqueue(
    text: string,
    over: { id?: string; attachments?: ChatComposerAttachment[] } = {},
  ): void {
    act(() => {
      useQueuedPrompts.getState().enqueue("s1", {
        id: over.id ?? `q-${text}`,
        text,
        attachments: over.attachments ?? [],
        state: "queued",
      });
    });
  }

  /** A ready-made queue attachment (the store's shape, NOT built through the
   * factory, so a test cannot fail because of `createChatComposerAttachment`). */
  function queuedAttachment(name: string, objectUrl: string): ChatComposerAttachment {
    return {
      id: `att-${name}`,
      file: new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" }),
      filename: name,
      mimeType: "image/png",
      sizeBytes: 3,
      objectUrl,
    };
  }

  /** Lock the composer the way a real turn does, then release it — the ONE
   * falling edge the **Flush** is keyed on. */
  async function runTurnAndSettle(): Promise<void> {
    act(() => {
      useSessions.getState().beginTurn("s1");
    });
    act(() => {
      useSessions.getState().turnCompleted("s1", "end_turn");
    });
    await flush();
  }

  it("a busy→idle fall sends the queue head as an ordinary prompt", async () => {
    seedLiveSession();
    render(<ChatStream />);
    // Locked: the prompt has nowhere to go but the queue.
    act(() => {
      useSessions.getState().beginTurn("s1");
    });
    enqueue("check the tests");
    expect(sendPrompt).not.toHaveBeenCalled();
    // The settle is the trigger: the entry becomes a plain `send_prompt`.
    act(() => {
      useSessions.getState().turnCompleted("s1", "end_turn");
    });
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith("s1", "check the tests"));
    // And it behaves like a SEND, not a note: a user row exists and the turn
    // bookkeeping opened (the same tail a typed prompt runs).
    const msgs = useSessions.getState().messages["s1"] ?? [];
    expect(msgs.some((m) => m.kind === "user" && m.text === "check the tests")).toBe(true);
    // Nothing survives as merely "queued": whatever is still in the list left
    // as `sent` (the row's exit may already have called `forget`, which deletes
    // the key — the `sent` half of that is pinned in `QueueRows.test.tsx`).
    expect(queue().every((p) => p.leaving === "sent")).toBe(true);
  });

  it("the Flush runs `sendText`, so a queued Mention expands at send (not at enqueue)",
    async () => {
      // RE-SEEDED HERE, and only here, because of a PRE-EXISTING leak this test
      // is the first to step in: the picker-filter describe above calls
      // `listSkills.mockResolvedValue([skill-manager, …])` — PERSISTENT, not
      // `…Once` — and the file's `beforeEach` uses `clearAllMocks()`, which drops
      // the CALL HISTORY but keeps the IMPLEMENTATION. Every other
      // expansion-asserting test sits EARLIER in the file, so it never sees the
      // override; a new one appended at the bottom does, and `$debug` would then
      // match nothing and be sent verbatim. Restoring the default catalog inside
      // this test (rather than editing the shared `beforeEach`) keeps the fix
      // local to the new case and cannot change what any existing test sees.
      vi.mocked(listSkills).mockResolvedValue([
        {
          name: "debug",
          description: "Debug a failure",
          path: "/s/.agents/skills/debug/SKILL.md",
          dir: "/s/.agents/skills/debug",
          scope: "space",
          body: "Step 1. Step 2.",
          disableModelInvocation: false,
          shadowed: [],
        },
      ]);
      seedLiveSession();
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      act(() => {
        useSessions.getState().beginTurn("s1");
      });
      // Through the composer, so this pins the WHOLE trip: raw in the queue →
      // expanded on the wire.
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "fix $debug " },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      expect(queue()[0]?.text).toBe("fix $debug");
      act(() => {
        useSessions.getState().turnCompleted("s1", "end_turn");
      });
      const expanded =
        'fix $debug\n\n<skill name="debug" location="/s/.agents/skills/debug/SKILL.md">' +
        "\nReferences are relative to /s/.agents/skills/debug." +
        "\n\nStep 1. Step 2.\n</skill>";
      // The SAME block a typed prompt produces — the proof the Flush reached
      // `sendText` rather than reimplementing the send.
      await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith("s1", expanded));
      const userMsg = (useSessions.getState().messages["s1"] ?? []).find(
        (m) => m.kind === "user",
      );
      expect(userMsg?.kind === "user" ? userMsg.text : null).toBe(expanded);
    });

  it("one settle sends ONE entry and the next settle sends the next (queue order)",
    async () => {
      seedLiveSession();
      const { container } = render(<ChatStream />);
      act(() => {
        useSessions.getState().beginTurn("s1");
      });
      enqueue("first", { id: "q-first" });
      enqueue("second", { id: "q-second" });
      // The head's send stays in flight for the whole first window, so
      // "one per settle" is measured, not assumed.
      const inflight = deferred<StopReason>();
      vi.mocked(sendPrompt).mockImplementationOnce(() => inflight.promise);
      act(() => {
        useSessions.getState().turnCompleted("s1", "end_turn");
      });
      await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
      expect(sendPrompt).toHaveBeenLastCalledWith("s1", "first");
      expect(sendPrompt).not.toHaveBeenCalledWith("s1", "second");
      // The head is the one that left: the second entry is untouched and its
      // row is still on screen.
      expect(screen.getByText("second")).toBeTruthy();
      await act(async () => {
        inflight.resolve("end_turn");
      });
      // THAT settle (the flush's own turn ending) is the next edge, and it
      // takes the next entry.
      await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith("s1", "second"));
      expect(sendPrompt).toHaveBeenCalledTimes(2);
      // Both rows are gone once their exits finish.
      await waitFor(() =>
        expect(container.querySelectorAll('[data-testid="queue-row"]')).toHaveLength(0),
      );
    });

  it("a failed Flush puts the entry back at the head marked `failed` and sends EXACTLY once",
    async () => {
      seedLiveSession();
      vi.mocked(sendPrompt).mockRejectedValueOnce(new Error("boom"));
      render(<ChatStream />);
      act(() => {
        useSessions.getState().beginTurn("s1");
      });
      enqueue("doomed", { id: "q-doomed" });
      act(() => {
        useSessions.getState().turnCompleted("s1", "end_turn");
      });
      await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
      // THE NO-RETRY-LOOP PIN — the count, not just the requeue. `sendText` ran
      // `beginTurn` before rejecting, so the failure's own `turnCompleted`
      // makes `busy` fall AGAIN: that self-inflicted edge must find nothing to
      // send, or every failure re-sends itself into the next failure.
      await flush();
      await flush();
      expect(sendPrompt).toHaveBeenCalledTimes(1);
      // Back at the head, live, marked, and still showing its text.
      const entry = queue()[0];
      expect(entry).toMatchObject({ id: "q-doomed", text: "doomed", failed: true });
      expect(entry?.leaving).toBeUndefined();
      // And a further settle still does not re-send it — only an edit will.
      await runTurnAndSettle();
      expect(sendPrompt).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Failed")).toBeTruthy();
    });

  it("saving an edit of the failed entry makes it flushable again", async () => {
    seedLiveSession();
    vi.mocked(sendPrompt).mockRejectedValueOnce(new Error("boom"));
    render(<ChatStream />);
    act(() => {
      useSessions.getState().beginTurn("s1");
    });
    enqueue("doomed", { id: "q-edit" });
    act(() => {
      useSessions.getState().turnCompleted("s1", "end_turn");
    });
    await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    // The retry gesture is the one the row already offers: edit and Save.
    fireEvent.click(screen.getByTestId("queue-row-body"));
    // TWO textareas are on screen now (the composer always is), so the editor
    // is the one INSIDE the stack — not "the second one", which is an
    // assumption about DOM order this test does not own.
    const editor = within(screen.getByTestId("queue-rows")).getByRole("textbox");
    fireEvent.change(editor, { target: { value: "doomed, but reworded" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(queue()[0]).toMatchObject({ text: "doomed, but reworded", failed: undefined });
    await runTurnAndSettle();
    // Now it sends — once.
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith("s1", "doomed, but reworded"),
    );
    expect(sendPrompt).toHaveBeenCalledTimes(2);
  });

  it("a prompt queued during an IDLE compaction flushes when the compaction ends",
    async () => {
      // The case an `inTurn`-keyed trigger would miss: an idle compaction emits
      // no `turn_start` / `agent_settled`, so `inTurn` stays false for the whole
      // of it and only the COMPOSITE `composerLocked` ever falls.
      seedLiveSession();
      render(<ChatStream />);
      await act(async () => {
        useSessions.getState().applySessionUpdate("s1", {
          sessionUpdate: "compaction_update",
          active: true,
          reason: "manual",
        });
      });
      enqueue("after the compact", { id: "q-compact" });
      expect(sendPrompt).not.toHaveBeenCalled();
      // The compaction ends — `compacting` clears and that IS the falling edge.
      await act(async () => {
        useSessions.getState().applySessionUpdate("s1", {
          sessionUpdate: "compaction_update",
          active: false,
          reason: "manual",
        });
      });
      await waitFor(() =>
        expect(sendPrompt).toHaveBeenCalledWith("s1", "after the compact"),
      );
    });

  it("a successful Flush RELEASES its attachment's object URL", async () => {
    // Task 1's `forget` refuses to release a `"sent"` entry precisely because
    // the DISPATCH path does — so if `flushHead` did not, a successfully-sent
    // attachment would leak until the Session closed.
    seedLiveSessionWithImages();
    render(<ChatStream />);
    act(() => {
      useSessions.getState().beginTurn("s1");
    });
    enqueue("look at [image #1]", {
      id: "q-img",
      attachments: [queuedAttachment("q.png", "blob:mock-q.png")],
    });
    act(() => {
      useSessions.getState().turnCompleted("s1", "end_turn");
    });
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith("s1", "look at [image #1]", [
        { name: "q.png", mimeType: "image/png", sizeBytes: 3, data: "AQID" },
      ]),
    );
    await waitFor(() =>
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-q.png"),
    );
  });

  it("a Flush to an agent that cannot take images sends TEXT-ONLY (fail-closed)",
    async () => {
      // `send()` fail-closes on `imageCapable` twice; the queue path must not be
      // the one route that ships an image to an agent that can't take one.
      seedLiveSession(); // capabilities {} — NOT image-capable
      render(<ChatStream />);
      act(() => {
        useSessions.getState().beginTurn("s1");
      });
      enqueue("see [image #1]", {
        id: "q-noimg",
        attachments: [queuedAttachment("q.png", "blob:mock-q.png")],
      });
      act(() => {
        useSessions.getState().turnCompleted("s1", "end_turn");
      });
      await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
      // The TWO-arg call — no images array on the wire at all.
      expect(vi.mocked(sendPrompt).mock.calls[0]).toHaveLength(2);
      expect(sendPrompt).toHaveBeenCalledWith("s1", "see [image #1]");
    });

  it("renders with no active session without crashing, and still flushes once one appears",
    async () => {
      // The hook-count pin: `useSessionIdleEdge` sits BEFORE the
      // `!activeSessionId` early return, so the early-return frame and the
      // full frame call the same number of hooks. A hook placed after that
      // return throws "Rendered more hooks than during the previous render"
      // here (the white-page crash).
      enqueue("queued with no session", { id: "q-nosession" });
      render(<ChatStream />);
      expect(
        screen.getByText("No active session — open a Space from the tabs above"),
      ).toBeTruthy();
      // The same component now takes the full-frame path with a queue already
      // in it: no hook-count crash, and the busy→idle fall still reaches
      // `flushHead` through the ref.
      act(() => {
        seedLiveSession();
        useSessions.getState().beginTurn("s1");
      });
      act(() => {
        useSessions.getState().turnCompleted("s1", "end_turn");
      });
      await waitFor(() =>
        expect(sendPrompt).toHaveBeenCalledWith("s1", "queued with no session"),
      );
    });

  it("a Session switch away from a BUSY session does NOT flush the arrived-at Session's queue",
    async () => {
      // THE H1 PIN, at the component level. `useSessionIdleEdge` is handed ONE
      // boolean — `composerLocked` of whoever is on screen — so clicking a tab
      // from a mid-turn Session to an idle one moves that single value
      // `true → false` in ONE render. The hook must not read a fall across two
      // different Sessions, because `flushHead` reads
      // `activeSessionIdRef.current` — ALREADY the Session just arrived at — so
      // the tab click would dispatch that Session's queued head with no user
      // gesture. Worse, `useMentionCatalogs` serves its empty constants until
      // the new Session's Space fetch resolves, so a `$mention` in that entry
      // would expand against an EMPTY catalog and ship verbatim.
      //
      // Two LIVE sessions, the way the tab bar holds them: `s2` is mid-turn and
      // on screen, `s1` is idle and has a queued entry (which per ADR 0069's
      // Visible-Session-only rule must hold until `s1` goes idle WHILE on
      // screen).
      useSessions.setState({
        activeSessionId: "s2",
        sessions: [
          { sessionId: "s1", cwd: "/home/u/proj", capabilities: {}, archived: false },
          { sessionId: "s2", cwd: "/home/u/proj", capabilities: {}, archived: false },
        ],
        spaces: [{ path: "/home/u/proj", createdAt: 1, lastOpenedAt: 1, trusted: false }],
        historySessions: [],
        messages: { s1: [], s2: [] },
        inTurn: {},
        stopReasons: {},
        closeReasons: {},
        configOptions: {},
        compacting: {},
      });
      render(<ChatStream />);
      // `s2` — the visible one — is mid-turn: `composerLocked` is true.
      act(() => {
        useSessions.getState().beginTurn("s2");
      });
      expect(useSessions.getState().inTurn["s2"]).toBe(true);
      // `s1` (hidden, idle) has a prompt waiting. Queued directly rather than
      // through the composer, which is locked and belongs to `s2`.
      act(() => {
        useQueuedPrompts.getState().enqueue("s1", {
          id: "q-switch",
          text: "hold until s1 settles on screen",
          attachments: [],
          state: "queued",
        });
      });
      // THE TAB CLICK: `activeSessionId` moves to the idle `s1`, so
      // `composerLocked` falls in the same render that changes the SUBJECT.
      await act(async () => {
        useSessions.setState({ activeSessionId: "s1" });
      });
      await flush();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      // NOTHING dispatched — not to `s1` (the arrived-at session, whose head a
      // buggy edge would take) and not to `s2` either.
      expect(sendPrompt).not.toHaveBeenCalled();
      // `s1`'s entry is still LIVE and queued: a switch neither sends it nor
      // marks it `leaving`.
      expect(queue("s1").map((p) => p.id)).toEqual(["q-switch"]);
      expect(queue("s1")[0]?.leaving).toBeUndefined();
      // And the hook is now ARMED on `s1`: a fall it actually observes while
      // `s1` is on screen does flush — declining the switch is not declining
      // the Session.
      act(() => {
        useSessions.getState().beginTurn("s1");
      });
      act(() => {
        useSessions.getState().turnCompleted("s1", "end_turn");
      });
      await waitFor(() =>
        expect(sendPrompt).toHaveBeenCalledWith(
          "s1",
          "hold until s1 settles on screen",
        ),
      );
    });

  it("a Flush whose attachment READ fails settles NO turn and keeps the previous stop reason",
    async () => {
      // THE M4 PIN. `send()`'s attachment-read arm returns WITHOUT settling —
      // nothing was dispatched, so there is no turn to close. `flushHead` shares
      // ONE catch for both halves of its body, so a `FileReader` failure (which
      // happens BEFORE `sendText`, hence before `beginTurn`) used to run
      // `turnCompleted(sessionId, "end_turn")` on a turn that was never opened:
      // that overwrites the PREVIOUS turn's stop reason and hides the footer's
      // "Turn ended: …" line, for a prompt that never went anywhere.
      //
      // The trigger here is an IDLE COMPACTION rather than a turn, precisely
      // because a turn's own `turnCompleted` would have written `end_turn`
      // anyway — compaction leaves the previous turn's stop reason standing.
      const readSpy = vi
        .spyOn(chatAttachments, "readAttachmentAsBase64")
        .mockRejectedValueOnce(new Error("the picture vanished"));
      seedLiveSessionWithImages(); // image-capable, so the read is attempted
      act(() => {
        useSessions.setState({ stopReasons: { s1: "max_tokens" } });
      });
      render(<ChatStream />);
      await act(async () => {
        useSessions.getState().applySessionUpdate("s1", {
          sessionUpdate: "compaction_update",
          active: true,
          reason: "manual",
        });
      });
      enqueue("look at [image #1]", {
        id: "q-readfail",
        attachments: [queuedAttachment("broken.png", "blob:mock-broken.png")],
      });
      // The compaction ends → the falling edge → the Flush → the read rejects.
      await act(async () => {
        useSessions.getState().applySessionUpdate("s1", {
          sessionUpdate: "compaction_update",
          active: false,
          reason: "manual",
        });
      });
      await waitFor(() =>
        expect(screen.getByText("the picture vanished")).toBeTruthy(),
      );
      // The READ is what failed: nothing reached the wire.
      expect(sendPrompt).not.toHaveBeenCalled();
      // NO turn was opened and none was settled — so the previous turn's stop
      // reason is still the store's answer…
      expect(useSessions.getState().stopReasons["s1"]).toBe("max_tokens");
      // … and the footer's line is still on screen (`inTurn` is false and the
      // reason is not `end_turn`, which is exactly what the overwrite killed).
      expect(screen.getByText("Turn ended: max_tokens")).toBeTruthy();
      // The prompt still stays visible, live and marked — the failure is
      // reported, not swallowed, and only saving an edit retries it.
      expect(queue("s1")[0]).toMatchObject({ id: "q-readfail", failed: true });
      expect(queue("s1")[0]?.leaving).toBeUndefined();
      // And its attachment survives — the send path never owned these URLs, so
      // nothing here may revoke them (the preview has to still render).
      expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:mock-broken.png");
      readSpy.mockRestore();
    });

  it("the stack renders between the transcript island and the composer island", () => {
    seedLiveSession();
    render(<ChatStream />);
    act(() => {
      useSessions.getState().beginTurn("s1");
    });
    enqueue("in the stack", { id: "q-order" });
    const main = document.querySelector("main")!;
    const rows = screen.getByTestId("queue-rows");
    const composer = screen.getByTestId("composer-island");
    // SIBLINGS, in that order: the rows are IN the island column and in normal
    // flow, so they can never float over a Gate card or the streaming answer.
    expect(main.nextElementSibling).toBe(rows);
    expect(rows.nextElementSibling).toBe(composer);
    expect(rows.textContent).toContain("in the stack");
  });

  it("renders no queue-rows element at all when the queue is empty", () => {
    seedLiveSession();
    render(<ChatStream />);
    // The stack is `null` when there is nothing queued — no empty band above
    // the composer.
    expect(screen.queryByTestId("queue-rows")).toBeNull();
  });
});

// ── The surface pin ─────────────────────────────────────────────────────────
//
/** The surface pin's host: the hook called with the MINIMUM args, the ref it
 * must take over handed in by the caller (the wrapper is an implementation
 * detail — the assignment is the pin). */
function renderProbe(args: {
  flushRef: RefObject<() => void>;
  sendText: UseChatPromptDispatchResult["sendText"];
}) {
  function Probe() {
    const sendingSessionsRef = useRef<Set<string>>(new Set());
    const activeSessionIdRef = useRef<string | null>(null);
    usePromptQueueFlusher({
      flushRef: args.flushRef,
      sendText: args.sendText,
      sendingSessionsRef,
      activeSessionIdRef,
      imageCapable: true,
      setError: () => {},
    });
    return null;
  }
  render(<Probe />);
}

describe("usePromptQueueFlusher — the surface pin", () => {
  it("hands the idle edge a LIVE flushHead: assigns flushRef.current and guards the Visible-Session rule", async () => {
    // The seam `useSessionIdleEdge`'s `onIdle: () => flushRef.current()` rests
    // on: a hook that stopped assigning the ref (or assigned a stale one) would
    // silently kill the **Flush** — no error, no red, just a queue that never
    // drains. The component declares the ref (initially a no-op) and the hook
    // takes it over during RENDER, the same render-phase mirror this codebase
    // uses for `attachmentsRef` / `draftRef`.
    // A plain object is enough here: the pin is about the ASSIGNMENT, and this
    // probe is not re-rendered (no hook is needed to hold the ref).
    const flushRef: RefObject<() => void> = { current: () => {} };
    const initial = flushRef.current;
    const sendText = vi.fn().mockResolvedValue("end_turn");
    renderProbe({ flushRef, sendText });
    expect(flushRef.current).not.toBe(initial);
    // The Visible-Session rule's FIRST line: `flushHead` reads
    // `activeSessionIdRef.current` and bails on `null` before it so much as
    // touches the queue — the probe's ref holds `null`, so nothing dispatches.
    await act(async () => {
      flushRef.current();
    });
    expect(sendText).not.toHaveBeenCalled();
  });
});
