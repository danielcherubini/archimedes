import { beforeEach, describe, expect, it, vi, beforeAll } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import ChatStream from "../components/ChatStream";
import {
  sendPrompt,
  compactSession,
  resumeSession,
  listSkills,
} from "../lib/tauri";
import { useSessions } from "../store/sessions";
import { useQueuedPrompts } from "../store/queuedPrompts";
import { useInteractive } from "../store/interactive";
import { setSidePaneCollapsed } from "../lib/sidePaneState";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import { clearMentionCatalogsCache } from "../hooks/useMentionCatalogs";
import { resetStores } from "../test/resetStores";
import {
  seedLiveSession,
  seedLiveSessionWithImages,
  seedStoredSession,
  pasteToComposer,
  flush,
  waitForCatalog,
} from "../test/chatStreamFixtures";
import {
  useChatPromptDispatch,
  type UseChatPromptDispatchResult,
} from "./useChatPromptDispatch";

/**
 * `useChatPromptDispatch` — the composer's dispatch core (issue #135 §2).
 *
 * The two groups below were MOVED VERBATIM out of `src/components/ChatStream.test.tsx`
 * alongside `sendText`, `send` and `resume`: the `/compact` Composer-command
 * group (ADR 0044, 7 tests) and the locked-composer queue-fork group (ADR 0069,
 * 9 tests). `it` titles and assertion bodies are unchanged; the only edits are
 * the `describe` titles (they now name their owning hook) and this file's module
 * shape. They KEEP rendering the real `<ChatStream />` — the hooks are proven
 * through the real component wiring, exactly as they were in the parent file.
 *
 * WHAT STAYED in `ChatStream.test.tsx` on purpose — the things only the real
 * component can prove: the failed-send end-to-end restore group (its second send
 * needs the real `sendText` + `readAttachmentAsBase64`), the `[image #N]`
 * staging-marker group, the staging-while-in-flight group, the capability
 * provenance pin, `"double-send is guarded by sendingRef"` (THE one-Set pin),
 * the `#`-collision/mask pins and the resume-capability pins. The Flush group
 * moved to `usePromptQueueFlusher.test.tsx` with `flushHead`.
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
 * (seeds, `flush`, `waitForCatalog`) — that is the documented, safe side.
 */

// The environment stubs `src/test/setup.tsx` does NOT provide (moved verbatim
// with the tests that need them).
//
// KEPT, and neither is redundancy:
//  - the object-URL pair: `setup.tsx` stubs no `URL` API, and staged
//    attachments need a deterministic `blob:` URL (Node's global `URL` reaches
//    jsdom but rejects web `Blob`s) — and the fork test below asserts
//    `URL.revokeObjectURL` was NOT called with a moved attachment's URL.
//  - the THREE `HTMLElement.prototype` stubs: `setup.tsx` puts `scrollIntoView`
//    on `Element.prototype` only, and the picker tests below read
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

// ---------------------------------------------------------------------------
// The `/compact` Composer command (ADR 0044).
//
// A Composer command is intercepted by the Client: it never becomes a user row,
// never expands as a Mention, and never reaches the Agent. Every dispatch below
// CLICKS Send — it never presses Enter. With a token under the caret the picker
// has a highlighted row, and the picker's keydown branch intercepts Enter to
// SELECT that row (inserting `/compact `), exactly as it does today for a `?` or
// `$` token. That is the accepted, pinned behaviour: Enter selects, and the user
// presses Enter again on a draft whose token has ended.
// ---------------------------------------------------------------------------
describe("useChatPromptDispatch — the /compact Composer command (ADR 0044)", () => {
  it("the / picker lists the command with its description, and never a skill", async () => {
    seedLiveSession();
    render(<ChatStream />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/" } });
    // The command row, with the description on its secondary line.
    expect(await screen.findByText("compact")).toBeTruthy();
    expect(screen.getByText("Summarize the older context now")).toBeTruthy();
    // The `else: skills.map(…)` fall-through trap: without an explicit `/` arm
    // BEFORE the Mention chain, an empty `/` query would list EVERY skill.
    expect(screen.queryByText("debug")).toBeNull();
    expect(screen.queryByText("beta")).toBeNull();
  });

  it("selecting the command row inserts `/compact ` (selectMention's existing fall-through)", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "/comp" } });
    await screen.findByText("compact");
    textarea.setSelectionRange(5, 5);
    // Enter is the PICKER's key here, not the send key — and nothing dispatches.
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "/compact ",
    );
    expect(compactSession).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
    // The trailing space ends the token, so the picker is gone and the next
    // Enter is a send.
    expect(screen.queryByText("compact")).toBeNull();
  });

  it("/compact dispatches compact_session with null instructions and sends nothing", async () => {
    seedLiveSession();
    render(<ChatStream />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/compact" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(compactSession).toHaveBeenCalledWith("s1", null));
    // Consumed, not sent: no prompt, no user row, no turn opened.
    expect(sendPrompt).not.toHaveBeenCalled();
    const messages = useSessions.getState().messages["s1"] ?? [];
    expect(messages.some((m) => m.kind === "user")).toBe(false);
    expect(useSessions.getState().inTurn["s1"]).toBeUndefined();
    // The draft is cleared, like any send.
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("/compact <args> reaches compact_session as the instructions", async () => {
    seedLiveSession();
    render(<ChatStream />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "/compact keep the tests" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(compactSession).toHaveBeenCalledWith("s1", "keep the tests"),
    );
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("a non-live answer (false) adds ONE system-style line with its own messageId", async () => {
    seedLiveSession();
    vi.mocked(compactSession).mockResolvedValueOnce(false);
    render(<ChatStream />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/compact" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(compactSession).toHaveBeenCalled());
    await flush();
    const messages = useSessions.getState().messages["s1"] ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      kind: "agent-text",
      text: "Nothing to compact — this session is not open.",
    });
    // Its OWN id (`client:<n>`), never the harness's `{stamp}:system` key (ADR
    // 0049 stamps the harness's bookkeeping ids; a pre-0049 transcript still
    // carries the bare `system`): the store appends a same-id chunk onto the
    // trailing agent-text with no separator, so a shared key would weld two
    // local lines into one bubble.
    const id = messages[0]!.kind === "agent-text" ? messages[0]!.messageId : "";
    expect(id.startsWith("client:")).toBe(true);
    expect(messages.some((m) => m.kind === "user")).toBe(false);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("/compact on a RESUMABLE stored session does not resume it (ADR 0044)", async () => {
    // The intercept sits BEFORE `send()`'s auto-resume block on purpose: a
    // resume would both cost a process spawn and make the session report LIVE,
    // which is exactly the flow ADR 0044 rejects.
    seedStoredSession({ loadSession: true });
    vi.mocked(compactSession).mockResolvedValueOnce(false);
    render(<ChatStream />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/compact" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(compactSession).toHaveBeenCalledWith("s1", null));
    expect(resumeSession).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("an unmatched /name sends BYTE-IDENTICALLY (the File-completion insert fall-through)", async () => {
    // The fixture is the literal draft a `?` FILE row produces at position 0: the
    // trigger is consumed and the ABSOLUTE path inserted (ADR 0033/0035). A
    // command namespace that claims a leading `/` must give this back verbatim.
    seedLiveSession();
    render(<ChatStream />);
    const text = "/etc/hosts has two entries";
    fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith("s1", text));
    expect(compactSession).not.toHaveBeenCalled();
    const messages = useSessions.getState().messages["s1"] ?? [];
    const user = messages.find((m) => m.kind === "user");
    expect(user?.kind === "user" ? user.text : null).toBe(text);
  });
});
// ── The **Prompt queue** (ADR 0069): `send()` forks to the queue while locked ─
//
// Today a locked composer is a dead key: `send()` returns on `composerLocked`
// and the words typed during inference have nowhere to go. The fork keeps the
// lock (the harness is still one-turn-at-a-time — nothing is DISPATCHED) and
// gives the draft somewhere to land: the per-Session queue, which a later
// **Flush** sends as an ordinary `send_prompt`.
//
// Three carve-outs are the feature, not incidental: an empty/marker-only draft
// is still a silent no-op (nothing to queue), a **Composer command** is NEVER
// queued (ADR 0044's defining act is that it is CONSUMED, and a queue entry's
// whole contract is "becomes an ordinary prompt" — so it gets a visible line
// instead of the dead key), and the attachments MOVE into the entry (their
// object URLs are kept, never revoked and recreated) so the preview survives
// the trip.
describe("useChatPromptDispatch — send() forks to the prompt queue while the composer is locked", () => {
  /** The composer's current draft text. */
  function composerValue(): string {
    return (screen.getByRole("textbox") as HTMLTextAreaElement).value;
  }

  /** The composer strip's thumbnail file names (an EMPTY strip is the point). */
  function composerThumbs(): string[] {
    const composer = document.querySelector('[data-testid="composer-island"]')!;
    return Array.from(composer.querySelectorAll("img")).map(
      (el) => el.getAttribute("alt") ?? "",
    );
  }

  function queue(sessionId = "s1") {
    return useQueuedPrompts.getState().bySession[sessionId] ?? [];
  }

  const png = (name: string, byte: number): File =>
    new File([new Uint8Array([byte, byte + 1, byte + 2])], name, {
      type: "image/png",
    });

  it("Enter while inTurn queues the draft instead of sending it", async () => {
    seedLiveSession();
    render(<ChatStream />);
    // Lock the composer the way a real turn does — `inTurn` (the store's
    // ground truth), NOT a disabled textarea (which stays editable on purpose).
    await act(async () => {
      useSessions.getState().beginTurn("s1");
    });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "check the tests " },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    // NOTHING was dispatched: the harness is still one-turn-at-a-time.
    expect(sendPrompt).not.toHaveBeenCalled();
    // The draft has somewhere to go now: one entry, carrying what was typed.
    const entries = queue();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ text: "check the tests", state: "queued" });
    // The composer is empty afterwards — the draft MOVED, it was not copied
    // (leaving it would queue it twice on the next Enter).
    expect(composerValue()).toBe("");
    // And no turn was opened, no user row written: queueing is not sending.
    expect(useSessions.getState().inTurn["s1"]).toBe(true);
    expect(
      (useSessions.getState().messages["s1"] ?? []).some((m) => m.kind === "user"),
    ).toBe(false);
  });

  it("queues a mention-bearing draft RAW (expansion runs at send, per ADR 0069)",
    async () => {
      seedLiveSession();
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      await act(async () => {
        useSessions.getState().beginTurn("s1");
      });
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "fix $debug " },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      expect(sendPrompt).not.toHaveBeenCalled();
      // The RAW draft — NOT the `<skill>` block form. Expansion at enqueue time
      // would bake a catalog snapshot into a prompt that sends later.
      expect(queue()[0]?.text).toBe("fix $debug");
    });

  it("an empty draft while locked stays a silent no-op (nothing to queue)", () => {
    seedLiveSession();
    useSessions.getState().beginTurn("s1");
    render(<ChatStream />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(queue()).toHaveLength(0);
    // And no feedback line — an empty Enter is a slip, not a refused request.
    expect(useSessions.getState().messages["s1"] ?? []).toHaveLength(0);
  });

  it("a marker-only draft with no attachments while locked queues nothing", () => {
    // The image-capable session, so the marker is not itself the reason for a
    // no-op: with no staged attachment there is nothing to send and nothing
    // worth queueing (`draftIsMarkerOnly`, the same rule the unlocked path uses).
    seedLiveSessionWithImages();
    useSessions.getState().beginTurn("s1");
    render(<ChatStream />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "[image #1]" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(queue()).toHaveLength(0);
  });

  it("a Composer command while locked is NOT queued — it answers with a line",
    async () => {
      seedLiveSession();
      useSessions.getState().beginTurn("s1");
      render(<ChatStream />);
      // The TRAILING SPACE matters: a bare `/compact` leaves the `/` picker open
      // with the caret on the token, and Enter is then the PICKER's key (it
      // inserts `/compact `, pre-existing behavior pinned at `:6402`) — never a
      // send. The space closes the token, so Enter reaches `send()`. (Clicking
      // Send is not an option here: the button is disabled while locked.)
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "/compact " },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      await flush();
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(compactSession).not.toHaveBeenCalled();
      // A queue entry's contract is "becomes an ordinary `send_prompt`", so a
      // command can NEVER live in the queue — it would be consumed as a prompt.
      expect(queue()).toHaveLength(0);
      // Visible feedback replaces today's dead key. `addSystemLine` routes
      // through `applySessionUpdate`'s `agent_message_chunk` arm, so the row's
      // kind is `agent-text` (`src/store/sessions.ts:1476-1481`) — NOT `system`.
      const messages = useSessions.getState().messages["s1"] ?? [];
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        kind: "agent-text",
        text: "/compact runs when this turn ends — try again then.",
      });
      // The draft is left ALONE — the command was never attempted, so the user
      // can simply press Enter again when the turn ends.
      expect(composerValue()).toBe("/compact ");
    });

  it("a locked send MOVES the staged attachment into the entry (no revoke, empty strip)",
    () => {
      seedLiveSessionWithImages();
      useSessions.getState().beginTurn("s1");
      render(<ChatStream />);
      pasteToComposer([png("s.png", 1)]);
      expect(composerThumbs()).toEqual(["s.png"]);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "look at [image #1]" },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      expect(sendPrompt).not.toHaveBeenCalled();
      const entry = queue()[0];
      expect(entry).toBeTruthy();
      // The attachment travelled WITH the text, and the marker numbering is
      // untouched: `#1` still names the first attachment of THAT message, and
      // message-ness survives the move, so there is nothing to renumber.
      expect(entry!.text).toBe("look at [image #1]");
      expect(entry!.attachments.map((a) => a.filename)).toEqual(["s.png"]);
      expect(entry!.attachments[0]!.objectUrl).toBe("blob:mock-s.png");
      // The URL was MOVED, not revoked-and-recreated — revoking here would kill
      // both the queue row's preview and the later send's file.
      expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:mock-s.png");
      // The composer's strip is empty (the attachment left with the entry).
      expect(composerThumbs()).toEqual([]);
      expect(composerValue()).toBe("");
    });

  it("a locked send queues on the `blocked` and `compacting` locks too (all three lock sources)",
    async () => {
      // `composerLocked` is `workingOrInTurn || agentState === "blocked" ||
      // compacting !== undefined` and every one of them enqueues. A `blocked`
      // Gate means the turn is unsettled, so no Flush can fire and the queue is
      // honest about waiting; a compaction is serialised ahead of the next
      // prompt by the harness itself.
      seedLiveSession();
      useInteractive.getState().applyState("s1", { state: "blocked" });
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "queued while blocked" } });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(queue().map((p) => p.text)).toEqual(["queued while blocked"]);

      // The compaction lock (a compaction is mid-flight: `compacting` is set —
      // driven through the real `compaction_update` frame, not a store poke).
      await act(async () => {
        useInteractive.getState().dismissSession("s1");
        useSessions.getState().applySessionUpdate("s1", {
          sessionUpdate: "compaction_update",
          active: true,
          reason: "manual",
        });
      });
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "queued while compacting" } });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(queue().map((p) => p.text)).toEqual([
        "queued while blocked",
        "queued while compacting",
      ]);
    });

  it("the turn ending FLUSHES the queue (the busy→idle edge is the Flush's trigger)", () => {
    // INVERTED by Task 5, and deliberately: when Task 3 landed there was no
    // **Flush**, so this pinned "nothing dispatches on the unlock". Task 5 mounts
    // the trigger — the falling edge of the COMPOSITE `composerLocked`, the same
    // flag the fork above keys on — so the settle now sends the head. The fork's
    // own contract is untouched: queueing still opens no turn and writes no user
    // row (pinned by the tests above); what changed is only that a settle is now
    // followed by one ordinary `send_prompt`.
    seedLiveSession();
    render(<ChatStream />);
    useSessions.getState().beginTurn("s1");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hold that" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    act(() => {
      useSessions.getState().turnCompleted("s1", "end_turn");
    });
    expect(sendPrompt).toHaveBeenCalledWith("s1", "hold that");
    // The entry left the queue (`takeHead` marked it `leaving: "sent"`).
    expect(queue().every((p) => p.leaving === "sent")).toBe(true);
  });

  it("an unlocked send still dispatches and queues nothing (the regression pin)",
    async () => {
      seedLiveSession();
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "hello" } });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith("s1", "hello"));
      expect(queue()).toHaveLength(0);
    });
});

// ── The surface pin ─────────────────────────────────────────────────────────
//
/** The surface pin's host: the hook called with stub args (the wrapper is an
 * implementation detail — the sorted key list is the pin). */
function renderHookLike(): { result: UseChatPromptDispatchResult } {
  let captured!: UseChatPromptDispatchResult;
  function Probe() {
    const draftRef = useRef("");
    const activeSessionIdRef = useRef<string | null>("s1");
    const sendingSessionsRef = useRef<Set<string>>(new Set());
    const attachmentsRef = useRef<never[]>([]);
    captured = useChatPromptDispatch({
      setDraft: () => {},
      setError: () => {},
      draftRef,
      activeSessionIdRef,
      sendingSessionsRef,
      composerLocked: false,
      isLive: true,
      canResume: false,
      hasImages: false,
      attachments: [],
      attachmentsRef,
      skills: [],
      agents: [],
      mcpServers: [],
      mcpMentionsEnabled: false,
      moveOutForSend: () => {},
      restoreHeldForSend: () => {},
      releaseHeldForSend: () => {},
      clearStaged: () => {},
    });
    return null;
  }
  render(<Probe />);
  return { result: captured };
}

describe("useChatPromptDispatch — the surface pin", () => {
  it("returns exactly the two dispatch handles ChatStream and the flusher consume, and no more", () => {
    const { result } = renderHookLike();
    // The sorted key list IS the contract wave 4 codes against: a handle added
    // or dropped reddens HERE rather than in a caller three files away.
    // `resume` is deliberately ABSENT — it moved in as a private closure used
    // by `send`'s `!isLive` arm, and `ChatStream` never destructures it (the
    // wave-2 `stageFiles` precedent: a handle whose only consumer moved with it
    // is not exposed, `noUnusedLocals` is what proves no site was missed).
    expect(Object.keys(result).sort()).toEqual(["send", "sendText"]);
  });
});
