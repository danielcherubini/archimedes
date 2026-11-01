import { beforeEach, describe, expect, it, vi, beforeAll, type Mock } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatStream from "./ChatStream";
import {
  sendPrompt,
  resumeSession,
  readFileBytes,
  cancelSession,
  listSkills,
  listMcpServersEffective,
  listAgentDefinitionsForSpace,
  listSpaceListing,
  type StopReason,
} from "../lib/tauri";
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import { clearMentionCatalogsCache } from "../hooks/useMentionCatalogs";
import { useSessions } from "../store/sessions";
import { useQueuedPrompts } from "../store/queuedPrompts";
import { useInteractive } from "../store/interactive";
import { usePermissions } from "../store/permissions";
import { useSettings } from "../store/settings";
import {
  brailleLoaderVariants,
  generateFrames,
  getVariantGridSize,
} from "../lib/braille-loader";
import {
  MIN_INDICATOR_WIDTH_CLASS,
  MIN_INDICATOR_WIDTH_PX,
} from "./chat/WorkingIndicator";
import type { AgentDefinitionDto, ListingDto } from "../lib/tauri";
import { setSidePaneCollapsed } from "../lib/sidePaneState";
// `import * as chatAttachments` removed by tsc (TS6133): its only consumer was
// the `readAttachmentAsBase64` spy inside the Flush group, which moved to
// `src/hooks/usePromptQueueFlusher.test.tsx` with `flushHead` (issue #135 §2).
// `import { activeMentionToken, isOutsideSpaceQuery } from "../lib/skills"`
// removed by tsc (TS6133): both were read only by the out-of-Space Directory
// completion group, which moved with them to
// `src/components/ChatStreamDirectoryCompletion.test.tsx` (issue #135 §5).
import { IPC_EVENTS } from "../lib/ipc/events";
import { resetStores } from "../test/resetStores";
import {
  MONO_ADVANCE_EM,
  SETTINGS_FIXTURE,
  PERSISTED_MCP_MESSAGE,
  seedLiveSession,
  seedStoredSession,
  seedArchivedSession,
  seedLiveSessionWithImages,
  seedMcpMentionsOn,
  seedMcpMentionsOff,
  pasteToComposer,
  dropOnComposer,
  flush,
  deferred,
  waitForCatalog,
} from "../test/chatStreamFixtures";

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

describe("ChatStream", () => {
  it("renders the empty state when there is no active session", () => {
    render(<ChatStream />);
    expect(
      screen.getByText(
        "No active session — open a Space from the tabs above",
      ),
    ).toBeTruthy();
  });

  it("survives the no-session → active-session transition (all hooks are called unconditionally, before the early return)", () => {
    // Render the early-return path first (no active session → the hook
    // count is N), then seed a live session and re-render (full frame →
    // the hook count must STILL be N). Any hook called only on the
    // full-frame path (after the `!activeSessionId` early return) would
    // throw "Rendered more hooks than during the previous render" here
    // (the white-page crash) — e.g. `usePendingSubagentRequests`.
    render(<ChatStream />);
    expect(
      screen.getByText(
        "No active session — open a Space from the tabs above",
      ),
    ).toBeTruthy();
    act(() => {
      seedLiveSession();
    });
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("renders the fresh-session hint for an empty transcript", () => {
    seedLiveSession();
    render(<ChatStream />);
    expect(screen.getByText("Send a prompt to start")).toBeTruthy();
  });

  it("renders the working indicator (BrailleLoader) when inTurn with no interactive state", () => {
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useSessions.getState().beginTurn("s1");
    render(<ChatStream />);
    // The `BrailleLoader` renders `role="status"`.
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("renders thinking block in transcript", async () => {
    seedLiveSession();
    const sessionId = "s1";
    useSessions.getState().addUserMessage(sessionId, "hi");
    useSessions.getState().applySessionUpdate(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "pondering" }, messageId: "m1" });
    useSessions.getState().beginTurn(sessionId);
    
    render(<ChatStream />);
    // Verify the "Thinking" label (scoped to the transcript's gradient text —
    // the thinking STUB that used to sit in the composer and show the same
    // "Thinking" placeholder is now the side pane's config block, and the pane
    // is not part of this render; the scope stays so the two can never collide
    // again if the pane is ever mounted under `ChatStream`).
    expect(screen.getByText("Thinking", { selector: ".animated-gradient-text" })).toBeTruthy();
    
    // Complete the turn
    act(() => {
      useSessions.getState().turnCompleted(sessionId, "end_turn");
    });
    
    // Verify "Thought" label (assert ONLY "Thought")
    expect(screen.getByText("Thought")).toBeTruthy();
  });

  it("renders done thinking block in history (not streaming)", () => {
    seedLiveSession();
    const sessionId = "s1";
    useSessions.getState().addUserMessage(sessionId, "hi");
    useSessions.getState().applySessionUpdate(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "done thought" }, messageId: "m1" });
    // Not in turn
    
    render(<ChatStream />);
    // Should show "Thought" (it never streamed)
    expect(screen.getByText("Thought")).toBeTruthy();
  });

  it("renders the working indicator from the interactive agentState alone (no inTurn)", async () => {
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useInteractive.getState().applyState("s1", { state: "working" });
    render(<ChatStream />);
    await flush();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("renders 'Waiting for your input…' when the interactive agentState is blocked", async () => {
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useInteractive.getState().applyState("s1", { state: "blocked" });
    render(<ChatStream />);
    await flush();
    expect(screen.getByText("Waiting for your input…")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  // --- The working indicator lives IN the composer's bottom row ------------
  //
  // It used to be a full-width bar parked ABOVE the composer box, pulled down
  // onto it with `-mb-2` so the two read as one surface. It is now a single
  // item IN that surface: the bottom row's left end, on the same line as the
  // `+` and Send buttons. So the two properties that bar needed — the `-mb-2`
  // hug, and being a row of its own between the transcript and the composer —
  // are gone, and what replaces them is that the indicator shares a line with
  // the actions and cannot push them off.

  it("renders the working indicator in the composer's bottom row, on the buttons' line", () => {
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useSessions.getState().beginTurn("s1");
    const { container } = render(<ChatStream />);
    // EXACTLY ONE indicator. The move relocates the row; it does not leave the
    // old bar above the composer standing there too (a `querySelector` would
    // happily read whichever copy came first and never notice the twin).
    const indicators = container.querySelectorAll(
      '[data-testid="working-indicator"]',
    );
    expect(indicators).toHaveLength(1);
    const indicator = indicators[0];
    // INSIDE the composer box (it used to sit outside it, above).
    const island = container.querySelector(
      '[data-testid="composer-island"]',
    ) as HTMLElement;
    expect(island.contains(indicator)).toBe(true);
    // SAME LINE as `+` and Send: the indicator and the button wrapper are
    // SIBLINGS of one flex row, and the indicator is the row's first item
    // (the buttons stay right-aligned via the wrapper's `ml-auto`).
    const attach = island.querySelector('[aria-label="Attach files"]')!;
    const buttonWrapper = attach.parentElement!;
    expect(indicator!.parentElement!.className).toContain("items-center");
    expect(indicator!.parentElement).toBe(buttonWrapper.parentElement);
    expect(indicator!.nextElementSibling).toBe(buttonWrapper);
    // It is NOT inside the button wrapper: that wrapper is `ml-auto` and holds
    // the actions only — putting the quip in there would right-align it too.
    expect(buttonWrapper.contains(indicator)).toBe(false);
    // The bar's own chrome is gone with the bar: no bottom-border separator, no
    // dim filler line after the quip, and no `-mb-2` hug (there is no gap left
    // to close — it is already inside the box).
    expect(indicator?.className).not.toContain("border-b");
    expect(indicator?.className).not.toContain("-mb-2");
    expect(indicator?.querySelector(".bg-foreground-subtlest")).toBeNull();
    // Still OUTSIDE the transcript's scroll region, so a long transcript cannot
    // scroll the working line away.
    expect(indicator?.closest(".overflow-y-auto")).toBeNull();
  });

  it("puts the 'Waiting for your input…' line in the same row", () => {
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useInteractive.getState().applyState("s1", { state: "blocked" });
    const { container } = render(<ChatStream />);
    const island = container.querySelector(
      '[data-testid="composer-island"]',
    ) as HTMLElement;
    const indicator = container.querySelector(
      '[data-testid="working-indicator"]',
    );
    expect(indicator?.textContent).toContain("Waiting for your input…");
    expect(island.contains(indicator)).toBe(true);
    expect(indicator!.closest(".overflow-y-auto")).toBeNull();
  });

  it("truncates the quip instead of pushing `+` and Send off the row", () => {
    // The row is a fixed-height flex line, and a quip can be ~60 characters
    // (see `lib/spin-quips.ts`). In a flex row an unshrinkable text child
    // GROWS the line and squeezes the buttons, so the text must be the thing
    // that gives: `min-w-0` + `truncate` on the text ITSELF (a flex child's
    // automatic minimum is its content width, which is what makes `truncate` a
    // no-op without it), and `shrink-0` on the button wrapper so a long quip
    // cannot squeeze two 24–28px hit targets.
    //
    // The `min-w-0` sits on the `<p>` and NOT on the indicator box, and that is
    // the fix: on the box it let the whole indicator shrink to nothing, which
    // is how the `shrink-0` spinner ended up painting over `+` (see the next
    // two cases). WHAT THIS TEST CAN AND CANNOT SAY is the same limit every
    // layout assertion here has — jsdom has no layout engine — so these are the
    // class contract, not a measured layout.
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useSessions.getState().beginTurn("s1");
    const { container } = render(<ChatStream />);
    const indicator = container.querySelector(
      '[data-testid="working-indicator"]',
    ) as HTMLElement;
    const text = indicator.querySelector("p") as HTMLElement;
    expect(text.className).toContain("truncate");
    // The item that shrinks is the TEXT, not the box that also holds the
    // spinner — so the shrink permission lives on the `<p>`.
    expect(text.className).toContain("min-w-0");
    expect(indicator.className).not.toContain("min-w-0");
    // `shrink-0` is on the wrapper, not on the buttons: flex would otherwise
    // squeeze BOTH buttons to fit the quip.
    const attach = container.querySelector(
      '[aria-label="Attach files"]',
    ) as HTMLElement;
    expect(attach.parentElement!.className).toContain("shrink-0");
    expect(attach.parentElement!.className).toContain("ml-auto");
  });

  it("floors the indicator's width at the widest spinner (the spinner cannot overlap `+`)", () => {
    // The narrow-row defect: the box used to carry a bare `min-w-0`, so under
    // enough pressure it shrank toward zero while its `shrink-0` spinner kept
    // its intrinsic ~50px and painted OVER the `+` button — with the quip fully
    // truncated and no way to stop it. The crossover is reachable at the app's
    // DEFAULT 800px window with the side pane open, so the box now has a floor
    // instead of a zero minimum.
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useSessions.getState().beginTurn("s1");
    const { container } = render(<ChatStream />);
    const indicator = container.querySelector(
      '[data-testid="working-indicator"]',
    ) as HTMLElement;
    expect(indicator.className).toContain(MIN_INDICATOR_WIDTH_CLASS);
    // The class is spelled as a LITERAL rather than interpolated from the px
    // number, because Tailwind scans source text and would never emit a class
    // built at runtime. So the pair needs pinning: the spacing step (14) times
    // the 0.25rem base must equal the px the arithmetic below is checked against.
    expect(MIN_INDICATOR_WIDTH_CLASS).toBe(
      `min-w-${MIN_INDICATOR_WIDTH_PX / 4}`,
    );
    // The floor must clear the WIDEST spinner the settings can pick, not just
    // the current one: the grid is at most 6 cells at the fixed `fontSize={14}`
    // in a 0.6em monospace advance, so ~50px — and 56px is above every variant.
    const widest = Math.max(
      ...brailleLoaderVariants.map(
        (v) => getVariantGridSize(v)[0] * 14 * MONO_ADVANCE_EM,
      ),
    );
    expect(MIN_INDICATOR_WIDTH_PX).toBeGreaterThanOrEqual(widest);
  });

  it("wraps the composer's bottom row so the floor cannot push Send off the edge", () => {
    // The floor only helps if the row may break: a `flex-1` item with a
    // `min-w` floor in a NON-wrapping row simply overflows the other end and
    // pushes Send out of the island. So the fallback is floor + wrap together,
    // and a regression on either half re-creates an overlap.
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useSessions.getState().beginTurn("s1");
    const { container } = render(<ChatStream />);
    const indicator = container.querySelector(
      '[data-testid="working-indicator"]',
    ) as HTMLElement;
    const row = indicator.parentElement as HTMLElement;
    expect(row.className).toContain("flex-wrap");
    // And the indicator keeps `flex-1` — the wrap only happens once the floor
    // binds, so on a normal-width row the indicator still absorbs the slack and
    // the buttons stay right-aligned on the SAME line.
    expect(indicator.className).toContain("flex-1");
  });

  it("does NOT wrap inside the indicator (the quip truncates beside the spinner, it does not drop under it)", () => {
    // The regression the first attempt at the fix shipped with: `flex-wrap` on
    // BOTH the row and the indicator box. A wrapping flex container breaks on a
    // flex item's HYPOTHETICAL main size, and the `<p>` has no flex-basis, so it
    // measures its CONTENT — ~420px for a 60-character quip, which never fits
    // beside the spinner. So the quip would break onto a second line and the
    // `truncate` would never run at all: a taller island whose height jumps as
    // the quips rotate, and no ellipsis anywhere. Worse than the overlap it
    // replaced. Wrapping is the ROW's job; inside the box the text only shrinks.
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useSessions.getState().beginTurn("s1");
    const { container } = render(<ChatStream />);
    const indicator = container.querySelector(
      '[data-testid="working-indicator"]',
    ) as HTMLElement;
    expect(indicator.className).not.toContain("flex-wrap");
    // The text still carries both halves of truncation, since nothing else can
    // make it give now that the box will neither wrap nor clip.
    const text = indicator.querySelector("p") as HTMLElement;
    expect(text.className).toContain("min-w-0");
    expect(text.className).toContain("truncate");
  });

  it("keeps the quip at full foreground ink (the composer fill is lighter than the chat plane)", () => {
    // The indicator's BACKGROUND moved with it: `--color-chat` (#232323) became
    // `--color-input` (#2b2b2b), and `foreground-subtle` on the new fill
    // measures 4.46:1 against the 4.76:1 it had on the old one — under WCAG's
    // 4.5:1 floor, on the line the user reads while the agent works. The token
    // is therefore load-bearing, not taste: a drift back to `-subtle` would be
    // invisible to every other test here.
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useSessions.getState().beginTurn("s1");
    const { container } = render(<ChatStream />);
    const text = container.querySelector(
      '[data-testid="working-indicator"] p',
    ) as HTMLElement;
    expect(text.className).toContain("text-foreground");
    expect(text.className).not.toMatch(/text-foreground-subtle/);
  });

  it("runs the configured spinner style (the settings store's spinnerStyle)", () => {
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useSessions.getState().beginTurn("s1");
    useSettings.getState().setSettings({
      ...SETTINGS_FIXTURE,
      spinnerStyle: "pendulum",
      emptyStateAnimation: null,
    });
    const { container } = render(<ChatStream />);
    const span = container.querySelector(
      '[data-testid="working-indicator"] span[aria-hidden="true"]',
    );
    // The initial frame of the configured variant (the `BrailleLoader`
    // renders `frames[0]` before its interval ticks).
    const [w, h] = getVariantGridSize("pendulum");
    expect(span?.textContent).toBe(generateFrames("pendulum", w, h).frames[0]);
  });

  it("falls back to the typing spinner when no spinnerStyle is set", () => {
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    useSessions.getState().beginTurn("s1");
    const { container } = render(<ChatStream />);
    const span = container.querySelector(
      '[data-testid="working-indicator"] span[aria-hidden="true"]',
    );
    const [w, h] = getVariantGridSize("typing");
    expect(span?.textContent).toBe(generateFrames("typing", w, h).frames[0]);
  });

  it("hides the working indicator when idle (no inTurn, no agentState)", () => {
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hi");
    const { container } = render(<ChatStream />);
    expect(
      container.querySelector('[data-testid="working-indicator"]'),
    ).toBeNull();
  });

  // --- The compaction indicator (ADR 0045): an IDLE compaction has no turn,
  // so neither `inTurn` nor `agentState` says "working" — the row's render
  // gate itself had to widen for `compacting`. ---

  it("shows the Compacting row at IDLE while a compaction runs (the widened gate)", () => {
    seedLiveSession();
    useSessions.setState({ compacting: { s1: "manual" } });
    const { container } = render(<ChatStream />);
    const indicator = container.querySelector(
      '[data-testid="working-indicator"]',
    );
    // The gate: nothing else would render the row here (no turn, idle agent).
    expect(indicator).toBeTruthy();
    // The LABEL. Read off the `<p>` rather than `getByText("Compacting")`:
    // the loader's `sr-only` label is a second match, and its `aria-hidden`
    // frame span contributes braille glyphs to `textContent`.
    expect(
      container.querySelector('[data-testid="working-indicator"] p')
        ?.textContent,
    ).toBe("Compacting");
  });

  it("labels every reason 'Compacting' (one label is the product decision)", () => {
    for (const reason of ["manual", "threshold", "overflow"] as const) {
      seedLiveSession();
      useSessions.setState({ compacting: { s1: reason } });
      const { container, unmount } = render(<ChatStream />);
      expect(
        container.querySelector('[data-testid="working-indicator"] p')
          ?.textContent,
      ).toBe("Compacting");
      unmount();
    }
  });

  it("overrides the user's spinner style with the pulse variant while compacting", () => {
    seedLiveSession();
    useSettings.getState().setSettings({
      ...SETTINGS_FIXTURE,
      spinnerStyle: "pendulum",
      emptyStateAnimation: null,
    });
    // BOTH a turn in flight AND a compaction: the pulse still wins (the
    // compaction branch sits above the spinner+quip branch).
    useSessions.getState().beginTurn("s1");
    useSessions.setState({ compacting: { s1: "threshold" } });
    const { container } = render(<ChatStream />);
    const span = container.querySelector(
      '[data-testid="working-indicator"] span[aria-hidden="true"]',
    );
    // The `pendulum` setting is IGNORED here: a compaction is a different
    // kind of wait, so this is a variant override, not the user's style.
    const [w, h] = getVariantGridSize("pulse");
    expect(span?.textContent).toBe(generateFrames("pulse", w, h).frames[0]);
  });

  it("does not render the rotating quip while compacting (one line, not two)", () => {
    seedLiveSession();
    useSessions.setState({ compacting: { s1: "manual" } });
    const { container } = render(<ChatStream />);
    expect(
      container.querySelectorAll('[data-testid="working-indicator"] p'),
    ).toHaveLength(1);
  });

  it("prefers the 'Waiting for your input…' line over Compacting when blocked AND compacting", () => {
    seedLiveSession();
    useSessions.setState({ compacting: { s1: "manual" } });
    useInteractive.getState().applyState("s1", { state: "blocked" });
    const { container } = render(<ChatStream />);
    const indicator = container.querySelector(
      '[data-testid="working-indicator"]',
    )!;
    // `blocked` needs an answer NOW — it outranks the spinner.
    expect(indicator.textContent).toContain("Waiting for your input…");
    expect(indicator.querySelector("p")?.textContent).toBe(
      "Waiting for your input…",
    );
  });

  it("clears the Compacting row when a coalescing batch carries both frames (a Skipped compaction)", async () => {
    seedLiveSession();
    const { container } = render(<ChatStream />);
    await act(async () => {
      // The two frames of a `Skipped` compaction in ONE rAF batch: last-wins
      // leaves it cleared, so no row (deliberate — a stuck row would lock the
      // composer on a session that already finished).
      useSessions.getState().applySessionUpdates([
        { sessionId: "s1", update: { sessionUpdate: "compaction_update", active: true, reason: "threshold" } },
        { sessionId: "s1", update: { sessionUpdate: "compaction_update", active: false, reason: "threshold" } },
      ]);
    });
    expect(
      container.querySelector('[data-testid="working-indicator"]'),
    ).toBeNull();
  });

  it("disables the send button and no-ops Enter while compacting (the harness is one-turn-at-a-time)", () => {
    seedLiveSession();
    render(<ChatStream />);
    const sendButton = screen.getByRole("button", { name: "Send" });
    const textarea = screen.getByRole("textbox");
    // Idle → enabled (sanity: the compaction has not started yet).
    fireEvent.change(textarea, { target: { value: "hi" } });
    expect(sendButton.hasAttribute("disabled")).toBe(false);
    act(() => {
      useSessions.setState({ compacting: { s1: "manual" } });
    });
    // The send is dead for the whole compaction (a prompt now would be
    // REJECTED by `send_prompt`), while the draft survives for when it ends.
    expect(sendButton.hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("Esc while compacting cancels the session (the Esc listener attaches at idle too)", async () => {
    seedLiveSession();
    render(<ChatStream />);
    // No turn in flight — the effect's gate had to widen for `compacting`,
    // or the listener would never be attached and Esc would do nothing.
    act(() => {
      useSessions.setState({ compacting: { s1: "overflow" } });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(vi.mocked(cancelSession)).toHaveBeenCalledWith("s1");
  });

  it("Esc while ANOTHER session compacts does NOT cancel the active one", async () => {
    seedLiveSession();
    render(<ChatStream />);
    act(() => {
      useSessions.setState({ compacting: { other: "manual" } });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(vi.mocked(cancelSession)).not.toHaveBeenCalled();
  });

  it("renders a FileSummaryCard with the turn's diff totals", () => {
    seedLiveSession();
    useSessions.setState({
      messages: {
        s1: [
          { kind: "user", text: "edit the files", at: 1 },
          // a.ts: +2 −1
          { kind: "diff", path: "src/a.ts", patch: "+x1\n+x2\n-y1", at: 2 },
          // b.ts: +0 −3
          { kind: "diff", path: "src/b.ts", patch: "-z1\n-z2\n-z3", at: 3 },
        ],
      },
    });
    render(<ChatStream />);
    // Totals: +2 −4.
    expect(screen.getByText("2 files changed")).toBeTruthy();
    expect(screen.getByText("−4")).toBeTruthy();
  });

  it("counts a re-emitted diff once (last patch wins)", async () => {
    seedLiveSession();
    useSessions.setState({
      messages: {
        s1: [
          { kind: "user", text: "edit", at: 1 },
          // The store re-emits the standalone `diff` on every
          // `tool_call_update` carrying content: the same file twice.
          { kind: "diff", path: "src/a.ts", patch: "+x\n-y", at: 2 }, // +1 −1
          {
            kind: "diff",
            path: "src/a.ts",
            patch: "+x1\n+x2\n-y1\n-y2\n-y3",
            at: 3,
          }, // +2 −3
        ],
      },
    });
    render(<ChatStream />);
    await flush();
    // The LATEST patch wins: +2 −3 (header total = the single file's
    // stats, so each appears twice: header + row); the superseded
    // +1 −1 is not counted.
    expect(screen.getByText("1 file changed")).toBeTruthy();
    expect(screen.getAllByText("−3")).toHaveLength(2);
    expect(screen.queryByText("+1")).toBeNull();
    expect(screen.queryByText("−1")).toBeNull();
  });

  it("renders the composer as a borderless ISLAND wearing the content surface", () => {
    // Two decisions, both pinned as negatives because both are one-keyboard
    // away from being silently reverted.
    //
    // NO BORDER: the frame used to be `border border-input-border`, i.e.
    // Dracula's Comment `#6272a4` — a slate VIOLET that reads as a purple
    // outline around the chat (`focus-within:border-input-border-focused` put
    // Functional Purple `#815cd6` on it while typing). The token is SHARED with
    // `input.tsx`/`select.tsx`/`ModelPicker`, which KEEP their borders, so this
    // is a per-site decision and only a class assertion can tell the two apart.
    //
    // SAME FILL AS THE TRANSCRIPT: the island is `bg-chat`, the same
    // token the transcript column and the side pane wear. That is only legible
    // because it is a SIBLING of the `main` with chrome between them — see the
    // next test. As a child it would have been invisible at 1.00.
    seedLiveSession();
    const { container } = render(<ChatStream />);
    const shell = container.querySelector('[data-testid="composer-island"]');
    expect(shell).toBeTruthy();
    expect(shell!.className).toContain("bg-composer");
    expect(shell!.className).not.toContain("border-input-border");
    expect(shell!.className).not.toMatch(/(^|\s)border(\s|$)/);
  });

  it("keeps the composer a SIBLING of the transcript, not its child", () => {
    // THE LOAD-BEARING STRUCTURE of the island layout. Chrome frames each
    // island, so the gap between them IS the separation: siblings of the same
    // fill read as two surfaces, a nested one reads as one. If the composer is
    // ever moved back inside the `main`, `bg-chat` on both collapses
    // to a single invisible plane (CR 1.00) — and with the border gone there is
    // nothing left to show the boundary.
    seedLiveSession();
    const { container } = render(<ChatStream />);
    const main = container.querySelector("main")!;
    const island = container.querySelector('[data-testid="composer-island"]')!;
    expect(main.contains(island)).toBe(false);
    // Same visual family as the transcript and the side pane: same radius, same
    // 4px margin, and `shrink-0` so the island never absorbs the column's
    // height shortfall (the `main` is `flex-1`/basis-0 and cannot shrink).
    expect(island.className).toContain("rounded-xl");
    expect(island.className).toContain("shrink-0");
    expect(main.className).toContain("rounded-xl");
  });

  it("the root main carries min-h-0 (a vertical flex item must be allowed to shrink — the transcript scrolls internally, not the window)", () => {
    seedLiveSession();
    const { container } = render(<ChatStream />);
    const main = container.querySelector("main");
    expect(main).toBeTruthy();
    // The `main` is a `flex-1` item of the center column (a `flex-col`):
    // without `min-h-0` the item's `min-height: auto` keeps it at the
    // transcript's height — it overflows the window (the composer is
    // pushed off-screen) and the inner `overflow-y-auto` div never scrolls.
    expect(main!.className).toContain("min-h-0");
  });

  it("shows the SINGLE placeholder 'Ask for follow-up changes' for a fresh live session (no history — the state if/else is gone)", () => {
    seedLiveSession();
    render(<ChatStream />);
    expect(screen.getByPlaceholderText("Ask for follow-up changes")).toBeTruthy();
  });

  it("shows the ZCode placeholder 'Ask for follow-up changes' for a live session WITH history", () => {
    seedLiveSession();
    useSessions.getState().addUserMessage("s1", "hello");
    render(<ChatStream />);
    expect(
      screen.getByPlaceholderText("Ask for follow-up changes"),
    ).toBeTruthy();
  });

  it("renders the composer textarea at full width (w-full — a width:auto <textarea> falls back to its intrinsic cols width, ~177px)", () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox");
    expect(textarea.className).toContain("w-full");
  });

  it("renders the ZCode-style send button (icon-md: size-7 rounded-lg — not the old circular size-8 rounded-full)", () => {
    seedLiveSession();
    render(<ChatStream />);
    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton.className).toContain("rounded-lg");
    expect(sendButton.className).not.toContain("rounded-full");
  });

  it("keeps the SINGLE placeholder for a live working session (the 'Agent is working…' if/else is gone — the working indicator carries the state)", () => {
    seedLiveSession();
    useSessions.getState().beginTurn("s1");
    render(<ChatStream />);
    expect(screen.getByPlaceholderText("Ask for follow-up changes")).toBeTruthy();
  });

  it("shows the SAME placeholder for a stored resumable session (no pause concept shown)", () => {
    seedStoredSession({ loadSession: true });
    render(<ChatStream />);
    // The stored session looks normal: the SAME single placeholder (the
    // auto-resume on send is silent — the pause/resume concept is not
    // shown).
    expect(screen.getByPlaceholderText("Ask for follow-up changes")).toBeTruthy();
    expect(
      screen.queryByPlaceholderText("Resume this session to send"),
    ).toBeNull();
  });

  it("shows the normal follow-up placeholder for a stored resumable session with messages", () => {
    seedStoredSession({ loadSession: true });
    useSessions.getState().addUserMessage("s1", "hi");
    render(<ChatStream />);
    // Identical to a live session with messages — no "Resume" wording.
    expect(
      screen.getByPlaceholderText("Ask for follow-up changes"),
    ).toBeTruthy();
  });

  it("shows the SAME placeholder for a history-only (closed) session (the 'This session is closed' if/else is gone)", () => {
    seedStoredSession();
    render(<ChatStream />);
    expect(screen.getByPlaceholderText("Ask for follow-up changes")).toBeTruthy();
  });

  // --- Auto-resume: a RESUMABLE stored session gets an enabled composer that
  // auto-resumes on send; a NON-RESUMABLE stored session stays fully disabled. ---

  it("enables the composer for a resumable stored session (no live session)", () => {
    seedStoredSession({ loadSession: true, promptCapabilities: { image: true } });
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox");
    // The textarea is NOT disabled (it used to be — stored sessions were read-only).
    expect(textarea.hasAttribute("disabled")).toBe(false);
    const sendButton = screen.getByRole("button", { name: "Send" });
    // Empty draft → still disabled…
    expect(sendButton.hasAttribute("disabled")).toBe(true);
    // …and enabled once there's a draft.
    fireEvent.change(textarea, { target: { value: "hi" } });
    expect(sendButton.hasAttribute("disabled")).toBe(false);
  });

  it("keeps the SEND disabled for a non-resumable stored session (a dead session can't receive a prompt — the harness rejects it)", () => {
    seedStoredSession(); // capabilities {} — no `loadSession`
    render(<ChatStream />);
    // The textarea stays editable (you can DRAFT — it just can't be SENT:
    // a non-resumable session has no agent process to deliver to, and the
    // harness's `send_prompt` rejects a prompt for an unknown session).
    const textarea = screen.getByRole("textbox");
    expect(textarea.hasAttribute("disabled")).toBe(false);
    expect(
      screen.getByRole("button", { name: "Send" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("send in a resumable stored session auto-resumes it, then sends", async () => {
    seedStoredSession({ loadSession: true, promptCapabilities: { image: true } });
    render(<ChatStream />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "resume and send" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // The stored session was resumed FIRST (the store action delegates to the
    // Tauri `resume_session` command, mocked above)…
    await waitFor(() =>
      expect(resumeSession).toHaveBeenCalledWith(
        "s1",
        "/home/u/proj",
      ),
    );
    // …then the prompt was sent (2-arg, text-only).
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith("s1", "resume and send"),
    );
  });

  it("a failed resume aborts the send", async () => {
    seedStoredSession({ loadSession: true, promptCapabilities: { image: true } });
    vi.mocked(resumeSession).mockRejectedValueOnce(new Error("nope"));
    render(<ChatStream />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hi" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // The resume failure surfaces its own error line…
    await waitFor(() => expect(screen.getByText("nope")).toBeTruthy());
    // …and the send was aborted (no prompt was sent to the stored session).
    expect(vi.mocked(sendPrompt)).not.toHaveBeenCalled();
  });

  // --- Task 5 (ADR 0016): the manual Resume affordances are GONE — the
  // banner is purely informational and the first send auto-resumes. ---

  it("a resumable stored session renders NO banner and no Resume button (it looks normal)", () => {
    seedStoredSession({ loadSession: true });
    render(<ChatStream />);
    // The pause concept is not shown: no stored/resume banner, no
    // history-only banner, no Resume button — the first send auto-resumes
    // silently.
    expect(
      screen.queryByText(
        "This session is stored. Sending a message resumes it.",
      ),
    ).toBeNull();
    expect(screen.queryByText(/History only/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("an archived-only session renders no banner and an enabled composer, and first send resumes", async () => {
    seedArchivedSession({ loadSession: true, promptCapabilities: { image: true } });
    render(<ChatStream />);
    // The `historySession` selector searches BOTH stored lists, so an
    // archived-only session gets an enabled composer (not "This session
    // is closed") and NO banner (the pause concept is not shown).
    expect(
      screen.queryByText(
        "This session is stored. Sending a message resumes it.",
      ),
    ).toBeNull();
    const textarea = screen.getByRole("textbox");
    expect(textarea.hasAttribute("disabled")).toBe(false);
    fireEvent.change(textarea, {
      target: { value: "resume the archived one" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // The first send auto-resumes the archived session…
    await waitFor(() =>
      expect(resumeSession).toHaveBeenCalledWith(
        "s9",
        "/home/u/arch",
      ),
    );
    // …and the message landed in `messages[s9]`.
    await waitFor(() =>
      expect(useSessions.getState().messages["s9"]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "user",
            text: "resume the archived one",
          }),
        ]),
      ),
    );
  });

  it("paste stages a thumbnail in a resumable stored session (capability read from the stored session)", () => {
    seedStoredSession({ loadSession: true, promptCapabilities: { image: true } });
    render(<ChatStream />);
    const intercepted = pasteToComposer([
      new File([new Uint8Array([1])], "s.png", { type: "image/png" }),
    ]);
    // The paste WAS intercepted — the capability came from the STORED
    // session's `capabilities` (a live-only read would fail closed).
    expect(intercepted).toBe(false);
    expect(screen.getByAltText("s.png")).toBeTruthy();
  });

  it("disables the send button while inTurn and when the draft is empty", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const sendButton = screen.getByRole("button", { name: "Send" });
    const textarea = screen.getByRole("textbox");
    // Empty draft → disabled.
    expect(sendButton.hasAttribute("disabled")).toBe(true);
    // Non-empty draft, idle → enabled.
    fireEvent.change(textarea, { target: { value: "hi" } });
    expect(sendButton.hasAttribute("disabled")).toBe(false);
    // inTurn (working) → send disabled again (the textarea stays EDITABLE
    // — you can draft while the agent works; Enter no-ops via `send()`'
    // `composerLocked` guard, the draft is kept for when the turn ends).
    await act(async () => {
      useSessions.getState().beginTurn("s1");
    });
    expect(sendButton.hasAttribute("disabled")).toBe(true);
    expect(textarea.hasAttribute("disabled")).toBe(false);
  });

  it("calls sendPrompt when Enter is pressed with a draft", () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(sendPrompt).toHaveBeenCalledWith("s1", "hello");
  });

  it("sending in one session does not block sending in another session (concurrent sessions)", async () => {
    let resolveS1!: (reason: StopReason) => void;
    vi.mocked(sendPrompt).mockImplementation((sessionId: string) => {
      if (sessionId === "s1") {
        return new Promise<StopReason>((resolve) => {
          resolveS1 = resolve;
        });
      }
      return Promise.resolve("end_turn");
    });

    try {
      useSessions.setState({
        activeSessionId: "s1",
        sessions: [
          { sessionId: "s1", cwd: "/home/u/proj1", capabilities: {}, archived: false },
          { sessionId: "s2", cwd: "/home/u/proj2", capabilities: {}, archived: false },
        ],
        spaces: [
          { path: "/home/u/proj1", createdAt: 1, lastOpenedAt: 1, trusted: false },
          { path: "/home/u/proj2", createdAt: 2, lastOpenedAt: 2, trusted: false },
        ],
        historySessions: [],
        messages: { s1: [], s2: [] },
        inTurn: {},
        stopReasons: {},
        closeReasons: {},
        configOptions: {},
        compacting: {},
      });

      render(<ChatStream />);

      // Send in s1
      const textarea = screen.getByRole("textbox");
      fireEvent.change(textarea, { target: { value: "hello from s1" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      expect(sendPrompt).toHaveBeenCalledWith("s1", "hello from s1");
      expect(useSessions.getState().inTurn.s1).toBe(true);

      // Switch to s2 while s1 is still in flight (working)
      await act(async () => {
        useSessions.setState({ activeSessionId: "s2" });
      });

      // In s2, user types and presses Enter
      const textareaS2 = screen.getByRole("textbox");
      fireEvent.change(textareaS2, { target: { value: "hello from s2" } });
      fireEvent.keyDown(textareaS2, { key: "Enter" });

      // s2 must NOT be blocked by s1's in-flight turn!
      await waitFor(() => {
        expect(sendPrompt).toHaveBeenCalledWith("s2", "hello from s2");
      });

      // Clean up pending s1 turn
      await act(async () => {
        resolveS1("end_turn");
      });
    } finally {
      vi.mocked(sendPrompt).mockReset();
      vi.mocked(sendPrompt).mockResolvedValue("end_turn");
    }
  });

  // --- Empty transcript + pending request (the request cards must NOT be
  // swallowed by the "Send a prompt to start" branch). ---

  it("renders a pending permission prompt on an empty transcript (no fresh-session hint)", () => {
    seedLiveSession();
    usePermissions.getState().addPrompt("s1", "req1", {
      toolCall: { title: "bash" },
      options: [{ optionId: "allow_once", name: "Allow once" }],
    });
    render(<ChatStream />);
    expect(screen.getByText("bash")).toBeTruthy();
    expect(screen.getByText("Allow once")).toBeTruthy();
    expect(screen.queryByText("Send a prompt to start")).toBeNull();
  });

  it("renders a stacked interactive ask on an empty transcript (no fresh-session hint)", () => {
    seedLiveSession();
    // No `toolCallId` → the card is NOT queued (it renders immediately,
    // unanchored).
    useInteractive.getState().addRequest("s1", {
      requestId: "req-ask",
      method: "ask",
      source: "main",
      params: {
        questions: [
          {
            id: "q1",
            question: "Which approach?",
            options: [{ label: "A" }, { label: "B" }],
          },
        ],
      },
    });
    render(<ChatStream />);
    expect(screen.getByText("Which approach?")).toBeTruthy();
    expect(screen.queryByText("Send a prompt to start")).toBeNull();
  });

  it("renders a pending sudo password request on an empty transcript (no fresh-session hint)", () => {
    seedLiveSession();
    // No `toolCallId` (absent for `password`) → the modal renders
    // immediately (unanchored).
    useInteractive.getState().addRequest("s1", {
      requestId: "req-pw",
      method: "password",
      source: "main",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    render(<ChatStream />);
    expect(screen.getByText("Sudo password required")).toBeTruthy();
    expect(screen.queryByText("Send a prompt to start")).toBeNull();
  });

  it("renders 'Waiting for your input…' on an empty transcript when the interactive agentState is blocked", async () => {
    seedLiveSession();
    useInteractive.getState().applyState("s1", { state: "blocked" });
    render(<ChatStream />);
    await flush();
    expect(screen.getByText("Waiting for your input…")).toBeTruthy();
    expect(screen.queryByText("Send a prompt to start")).toBeNull();
  });

  // --- Composer mismatch states (ONE predicate: `workingOrInTurn`). ---

  it("disables the send button and no-ops send() when the interactive agentState is working (no inTurn)", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const sendButton = screen.getByRole("button", { name: "Send" });
    const textarea = screen.getByRole("textbox");
    // Idle → enabled (sanity).
    fireEvent.change(textarea, { target: { value: "hi" } });
    expect(sendButton.hasAttribute("disabled")).toBe(false);
    // The interactive agentState says working (the `state` push races `turnCompleted`, or
    // the state latches after a turn) → the send is dead: button disabled,
    // the textarea stays editable (the draft is kept; Enter no-ops).
    await act(async () => {
      useInteractive.getState().applyState("s1", { state: "working" });
    });
    expect(sendButton.hasAttribute("disabled")).toBe(true);
    expect(textarea.hasAttribute("disabled")).toBe(false);
    // The placeholder is the single idle copy (the `working` mismatch does
    // not leave a stale copy behind — the working indicator carries the
    // state).
    expect(screen.getByPlaceholderText("Ask for follow-up changes")).toBeTruthy();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("disables the send button and no-ops Enter while the interactive agentState is blocked (mid-turn awaiting a request response)", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const sendButton = screen.getByRole("button", { name: "Send" });
    const textarea = screen.getByRole("textbox");
    // Idle → enabled (sanity: `blocked` has NOT been pushed yet).
    fireEvent.change(textarea, { target: { value: "hi" } });
    expect(sendButton.hasAttribute("disabled")).toBe(false);
    expect(textarea.hasAttribute("disabled")).toBe(false);
    // `inTurn` is true (a `blocked` agent is mid-turn — it is awaiting a
    // request response, so `inTurn` alone used to lock the composer) +
    // the interactive agentState says blocked → the send is dead for the whole
    // wait: button disabled (the textarea stays editable — the draft is
    // kept; Enter no-ops, no double-send, no clobbered turn bookkeeping).
    await act(async () => {
      useSessions.getState().beginTurn("s1");
      useInteractive.getState().applyState("s1", { state: "blocked" });
    });
    expect(sendButton.hasAttribute("disabled")).toBe(true);
    expect(textarea.hasAttribute("disabled")).toBe(false);
    expect(screen.getByPlaceholderText("Ask for follow-up changes")).toBeTruthy();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("keeps the composer LOCKED when the interactive agentState is idle but the store is inTurn", () => {
    seedLiveSession();
    useSessions.getState().beginTurn("s1");
    useInteractive.getState().applyState("s1", { state: "idle" });
    render(<ChatStream />);
    const sendButton = screen.getByRole("button", { name: "Send" });
    // A stale `idle` from the previous turn must not unlock the composer
    // while a turn is in flight (`inTurn` is the ground truth — the store
    // does not reset `agentState` on `turnCompleted`, a store follow-up):
    // the send is disabled and Enter no-ops (the textarea stays editable
    // — the draft is kept). The working indicator shows (the turn IS in
    // flight).
    const textarea = screen.getByRole("textbox");
    expect(sendButton.hasAttribute("disabled")).toBe(true);
    expect(textarea.hasAttribute("disabled")).toBe(false);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeTruthy();
  });

  it("prefers the 'Waiting for your input…' line over the braille loader when blocked AND inTurn", () => {
    seedLiveSession();
    useSessions.getState().beginTurn("s1");
    useInteractive.getState().applyState("s1", { state: "blocked" });
    render(<ChatStream />);
    // `blocked` + `inTurn` → `workingOrInTurn` is true, but the blocked
    // line takes precedence: the waiting line renders and the braille
    // loader (role="status") does NOT (both would render otherwise).
    expect(screen.getByText("Waiting for your input…")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  // The composer's bottom row carries the working indicator and the two action
  // buttons — and NOT the three config lines (context bar, model, reasoning),
  // which left for the side pane's `SessionConfigBlock`. These pins keep them
  // out: a re-landed bar or trigger would put ~600 mounted model `SelectItem`s
  // back into the subtree that re-renders on every keystroke (`draft` is the
  // composer's state), which is the perf coupling the move exists to kill. The
  // assertion reads the WHOLE island, so it covers the working indicator's slot
  // too — giving the row a new item must not become a doorway for them.
  it("the composer island hosts NO config line (they are the side pane's now)", () => {
    // A FULL session: usage known AND both config options present — the state
    // in which a re-landed bar/trigger would definitely render. Anything the
    // composer still renders for these is a regression; the pane is asserted
    // separately (`SidePane.test.tsx`).
    seedLiveSession();
    useSessions.setState({
      configOptions: {
        s1: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "acme/alpha",
            options: [{ value: "acme/alpha", name: "acme/Alpha" }],
          },
          {
            id: "thought_level",
            name: "Thinking",
            type: "select",
            currentValue: "medium",
            options: [{ value: "medium", name: "Medium" }],
          },
        ],
      },
      contextUsage: { s1: { used: 53760, window: 128000 } },
    });
    const { container } = render(<ChatStream />);
    const composer = container.querySelector(
      '[data-testid="composer-island"]',
    ) as HTMLElement;
    expect(composer).toBeTruthy();
    // Neither the context bar nor its track / label / icon.
    expect(
      composer.querySelector('[data-testid="context-usage-bar"]'),
    ).toBeNull();
    // Neither config trigger — the model trigger is a dialog BUTTON and the
    // thinking trigger a `combobox`, so check both roles and the raw labels.
    expect(composer.querySelector('[aria-label="Model"]')).toBeNull();
    expect(composer.querySelector('[aria-label="Thinking"]')).toBeNull();
    expect(
      composer.querySelector('[data-testid="session-config-controls"]'),
    ).toBeNull();
    // And nothing in the composer's subtree is a progressbar any more.
    expect(composer.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("keeps BOTH action buttons in the composer's bottom row, right-aligned together", () => {
    seedLiveSession();
    const { container } = render(<ChatStream />);
    const composer = container.querySelector(
      '[data-testid="composer-island"]',
    ) as HTMLElement;
    const attach = composer.querySelector(
      '[aria-label="Attach files"]',
    ) as HTMLElement;
    const send = composer.querySelector('[aria-label="Send"]') as HTMLElement;
    expect(attach).toBeTruthy();
    expect(send).toBeTruthy();
    // Both ride ONE `ml-auto` wrapper — that is what right-aligns them as a
    // pair. Splitting them (or dropping `ml-auto`) un-aligns the pair, which is
    // the layout the config lines' departure left behind and the reason the
    // wrapper still exists.
    expect(send.parentElement).toBe(attach.parentElement);
    expect(send.parentElement!.className).toContain("ml-auto");
    // They are the WRAPPER's only two children, Send last. (The wrapper, not
    // the row: the row's other item is the working indicator, and it is a
    // SIBLING of this wrapper — see the placement test above. Nothing may crowd
    // in beside the two actions, and Send stays the right-most thing in the
    // composer.)
    expect(send.parentElement!.childElementCount).toBe(2);
    expect(send.parentElement!.lastElementChild).toBe(send);
  });

  // --- The `+` attach button (the native file picker) ---

  it("renders an enabled `+` (Attach files) button for a live image-capable session", () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    const button = screen.getByRole("button", { name: "Attach files" });
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("the `+` button is disabled when the agent does not advertise image support (fail-closed)", () => {
    seedLiveSession(); // capabilities: {} — no `promptCapabilities.image`
    render(<ChatStream />);
    const button = screen.getByRole("button", { name: "Attach files" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("the `+` button STAYS enabled while a turn is in flight (staging is allowed; only Send locks)", () => {
    seedLiveSessionWithImages();
    useSessions.setState({ inTurn: { s1: true } });
    render(<ChatStream />);
    const button = screen.getByRole("button", { name: "Attach files" });
    // Mid-turn staging is allowed — the turn is not a capability check. The
    // `+` shares the paste/drop rule; only Send (which DISPATCHES) locks.
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("clicking `+` opens the file picker and stages the picked image", async () => {
    seedLiveSessionWithImages();
    vi.mocked(openFilePicker).mockResolvedValueOnce([
      "/home/u/pics/shot.png",
    ]);
    vi.mocked(readFileBytes).mockResolvedValueOnce([
      0x89, 0x50, 0x4e, 0x47, 1, 2, 3,
    ]);
    render(<ChatStream />);
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    // The picker opens (the dialog's image filter — the backend re-validates
    // the extension, the frontend re-validates the MIME on staging).
    expect(vi.mocked(openFilePicker)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openFilePicker).mock.calls[0][0]).toMatchObject({
      multiple: true,
    });
    // The picked file is staged as an attachment (the thumbnail appears —
    // the bytes were read via `read_file_bytes` and the MIME inferred from
    // the extension).
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Remove image attachment" }),
      ).toBeTruthy(),
    );
    expect(vi.mocked(readFileBytes)).toHaveBeenCalledWith(
      "/home/u/pics/shot.png",
    );
  });

  it("a cancelled picker (null) stages nothing", async () => {
    seedLiveSessionWithImages();
    vi.mocked(openFilePicker).mockResolvedValueOnce(null);
    render(<ChatStream />);
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    await waitFor(() => expect(vi.mocked(openFilePicker)).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Remove image attachment" })).toBeNull();
    expect(vi.mocked(readFileBytes)).not.toHaveBeenCalled();
  });

  it("a picker selection of a non-image path is skipped (the read returns null)", async () => {
    seedLiveSessionWithImages();
    vi.mocked(openFilePicker).mockResolvedValueOnce([
      "/home/u/pics/notes.txt",
    ]);
    vi.mocked(readFileBytes).mockResolvedValueOnce(null);
    render(<ChatStream />);
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    await waitFor(() => expect(vi.mocked(readFileBytes)).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Remove image attachment" })).toBeNull();
  });

  it("does NOT leak Reasoning state across sessions (per-session key)", () => {
    useSessions.setState({
      activeSessionId: "s1",
      sessions: [
        { sessionId: "s1", cwd: "/home/u/proj", capabilities: {}, archived: false },
        { sessionId: "s2", cwd: "/home/u/proj", capabilities: {}, archived: false },
      ],
      spaces: [{ path: "/home/u/proj", createdAt: 1, lastOpenedAt: 1, trusted: false }],
      historySessions: [],
      messages: {
        s1: [
          { kind: "user", text: "hi1", at: 1 },
          { kind: "agent-thought", messageId: "m1", text: "thought-one", at: 2 },
        ],
        s2: [
          { kind: "user", text: "hi2", at: 1 },
          { kind: "agent-thought", messageId: "m2", text: "thought-two", at: 2 },
        ],
      },
      inTurn: {},
      stopReasons: {},
      closeReasons: {},
      configOptions: {},
    });
    render(<ChatStream />);
    // s1's thinking block is collapsed by default…
    expect(screen.queryByText("thought-one")).toBeNull();
    // …and expands on click.
    fireEvent.click(screen.getByTestId("reasoning-trigger"));
    expect(screen.getByText("thought-one")).toBeTruthy();
    // Switching sessions must NOT reuse the same Reasoning instance at
    // the same index: s2's block starts collapsed (no inherited
    // expanded state or duration) and s1's content is gone.
    act(() => {
      useSessions.setState({ activeSessionId: "s2" });
    });
    expect(screen.queryByText("thought-two")).toBeNull();
    expect(screen.queryByText("thought-one")).toBeNull();
  });

  it("window-level drop backstop prevents navigation (drop outside the composer)", () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    // The window `drop` listener (registered in `useEffect`, present after
    // `render`'s `act` flush) swallows file drops OUTSIDE the composer — the
    // webview's default for a file drop would otherwise NAVIGATE to the file
    // (replacing the app; the reason `dragDropEnabled: false` + this
    // backstop exist). `fireEvent` returns `!defaultPrevented` → `false`
    // when the listener's `preventDefault` marked the event.
    const intercepted = fireEvent.drop(window, {
      dataTransfer: {
        files: [
          new File([new Uint8Array([1])], "w.png", { type: "image/png" }),
        ],
      },
    });
    expect(intercepted).toBe(false);
    // The event targeted `window` (the top of the tree — it does NOT bubble
    // down through the composer), so the composer's `onDrop` (`handleDrop`)
    // never fired: the drop was swallowed, NOT staged.
    expect(screen.queryByAltText("w.png")).toBeNull();
    // `dragover` variant: a file drag anywhere on the page must make the
    // page a valid drop target (otherwise the browser shows the "no-drop"
    // cursor and the drop would navigate).
    expect(fireEvent.dragOver(window, { dataTransfer: {} })).toBe(false);
  });

  it("shows the single placeholder for an image-capable fresh session (the capability if/else is gone)", () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    expect(
      screen.getByPlaceholderText("Ask for follow-up changes"),
    ).toBeTruthy();
  });

  it("switching sessions clears staged attachments", async () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    pasteToComposer([
      new File([new Uint8Array([1])], "s.png", { type: "image/png" }),
    ]);
    expect(screen.getByAltText("s.png")).toBeTruthy();
    // The `act` wrap is required — the session-change effect's `setAttachments`
    // only reliably flushes inside `act`.
    await act(async () => {
      useSessions.setState({
        activeSessionId: "s2",
        sessions: [
          {
            sessionId: "s2",
            cwd: "/home/u/proj",
            capabilities: {},
            archived: false,
          },
        ],
      });
    });
    expect(screen.queryByAltText("s.png")).toBeNull();
    // The session-change effect released the staged attachment (NOT just
    // cleared the strip) — the object URL was revoked. `toHaveBeenCalledWith`
    // (NOT `toHaveBeenCalledTimes`): `beforeEach`'s `vi.clearAllMocks()`
    // clears the call history per test, but a `some`-style assertion stays
    // robust if that ever changes.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-s.png");
  });

  // --- Send wiring: images ride along with the prompt (Task 5). ---

  it("send delivers images with the prompt", async () => {
    seedLiveSessionWithImages();
    const { container } = render(<ChatStream />);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "look at this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // `send()` is ASYNC (it awaits the FileReader read before `sendPrompt`) —
    // wait on the outcome, never assert synchronously.
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith("s1", "look at this", [
        { name: "s.png", mimeType: "image/png", sizeBytes: 3, data: "AQID" },
      ]),
    );
    // The store's last user message carries the images.
    const msgs = useSessions.getState().messages.s1;
    const last = msgs[msgs.length - 1];
    expect(last).toMatchObject({ kind: "user", text: "look at this" });
    if (last?.kind === "user") {
      expect(last.images).toEqual([
        { name: "s.png", mimeType: "image/png", sizeBytes: 3, data: "AQID" },
      ]);
    } else {
      expect(last).toBeNull();
    }
    // The composer thumbnail is GONE after success (released + cleared —
    // scoped to the composer: the transcript now renders the image too).
    const composer = container.querySelector('[data-testid="composer-island"]')!;
    const remaining = screen.getAllByAltText("s.png");
    expect(remaining.some((el) => composer.contains(el))).toBe(false);
    // …while the transcript renders it (the `data:` URL, read-only).
    expect(remaining).toHaveLength(1);
    expect(remaining[0].getAttribute("src")).toBe(
      "data:image/png;base64,AQID",
    );
  });

  it("staged thumbnails leave the composer AT SEND, not when the send resolves", async () => {
    seedLiveSessionWithImages();
    const { container } = render(<ChatStream />);
    // `sendPrompt` stays PENDING for the whole window under test: every
    // assertion below runs while the turn is still in flight, so a clear that
    // only happens after the promise resolves CANNOT be what satisfies them.
    // This is the test that pins the bug (the thumbnails used to sit in the
    // composer for the entire turn, even though the base64 copies had already
    // been handed to the user message).
    const inflight = deferred<StopReason>();
    vi.mocked(sendPrompt).mockImplementationOnce(() => inflight.promise);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "look at this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // The wait proves `send()` got PAST `addUserMessage`/`beginTurn` and is now
    // sitting inside `sendPrompt` — exactly the window the bug leaves a stale
    // copy on screen.
    await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
    const composer = container.querySelector('[data-testid="composer-island"]')!;
    // Exactly ONE copy of the image is on screen: the transcript's `data:`
    // render. The composer holds none. (Wrapped in `waitFor` because the
    // composer-clearing `setAttachments` lands outside `act`; it can never
    // become true later in this test, so the wait cannot false-green.)
    await waitFor(() => {
      const copies = screen.getAllByAltText("s.png");
      expect(copies).toHaveLength(1);
      expect(copies[0].getAttribute("src")).toBe("data:image/png;base64,AQID");
      expect(copies.some((el) => composer.contains(el))).toBe(false);
    });
    // NOT released while the turn runs — a failed send has to be able to put
    // the thumbnail back, and a revoked object URL renders nothing.
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:mock-s.png");
    // Settling the turn releases it for good (and nothing reappears).
    await act(async () => {
      inflight.resolve("end_turn");
    });
    await flush();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-s.png");
    expect(
      screen.getAllByAltText("s.png").some((el) => composer.contains(el)),
    ).toBe(false);
  });

  it("switching sessions while a send is in flight releases the LEFT session's held attachment", async () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    const inflight = deferred<StopReason>();
    vi.mocked(sendPrompt).mockImplementationOnce(() => inflight.promise);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "look at this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
    // Switch away mid-turn. The release point inside the session-change
    // effect only knows the session being ENTERED (`s2`), so the cleanup must
    // read the held list under the id of the session being LEFT (`s1`) —
    // otherwise the entry is dropped later by the failure path's `delete`
    // without ever being released (a permanent leak).
    await act(async () => {
      useSessions.setState({
        activeSessionId: "s2",
        sessions: [
          {
            sessionId: "s1",
            cwd: "/home/u/proj",
            capabilities: { promptCapabilities: { image: true } },
            archived: false,
          },
          {
            sessionId: "s2",
            cwd: "/home/u/proj",
            capabilities: {},
            archived: false,
          },
        ],
      });
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-s.png");
    await act(async () => {
      inflight.resolve("end_turn");
    });
  });

  it("a non-Error rejection shows the message, not [object Object]", async () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    // Tauri IPC errors arrive as plain objects, not `Error` instances.
    vi.mocked(sendPrompt).mockRejectedValueOnce({
      kind: "error",
      message: "proto",
    });
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText("proto")).toBeTruthy());
  });

  it("an image-only send is blocked when the capability regresses mid-session (a marker is not prose)",
    async () => {
      // `hasImages` exists for exactly one case a session switch cannot produce:
      // a same-session capability regression. With the draft now reading
      // `[image #1]` instead of `""`, the "image-only send is blocked" rule
      // needs to see a marker-only draft as no prose — otherwise the sentence
      // "here is [image #1]" ships to an agent that receives NO image.
      seedLiveSessionWithImages();
      render(<ChatStream />);
      pasteToComposer([
        new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
      ]);
      await act(async () => {
        useSessions.setState({
          sessions: [
            { sessionId: "s1", cwd: "/home/u/proj", capabilities: {}, archived: false },
          ],
        });
      });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await flush();
      expect(vi.mocked(sendPrompt)).not.toHaveBeenCalled();
    });

  it("image-only send is allowed", async () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    // No text typed — the send button is enabled for an image-only send.
    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(sendButton);
    // The text is now `"[image #1]"`, NOT `""` — and that is the intended
    // semantics of this task: a bare screenshot paste now TELLS the model which
    // image it is (the marker names the Nth image of this prompt, which is the
    // only reading the wire supports), instead of sending an empty prompt with an
    // anonymous image attached.
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith("s1", "[image #1]", [
        { name: "s.png", mimeType: "image/png", sizeBytes: 3, data: "AQID" },
      ]),
    );
  });

  it("empty composer with no attachments: send stays disabled", () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    expect(
      screen.getByRole("button", { name: "Send" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("double-send is guarded by sendingRef", async () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    expect(screen.getByAltText("s.png")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hi" },
    });
    const sendButton = screen.getByRole("button", { name: "Send" });
    // Two synchronous clicks BEFORE the first send's FileReader `await`
    // resolves: `beginTurn` (which would lock the composer) runs only AFTER
    // the read, so the composer is still unlocked for the second click —
    // the race the `sendingRef` guard exists for. Without it, both `send()`
    // calls would reach `sendPrompt`.
    fireEvent.click(sendButton);
    fireEvent.click(sendButton);
    // Exactly ONE send, even though the composer was not locked during the
    // first send's FileReader await. Assert the count only AFTER both send
    // continuations have run: a `toHaveBeenCalledTimes(1)` inside `waitFor`
    // would pass the moment it first observed one call — a false-green window
    // if the `sendingRef` guard were removed, since the second send's
    // continuation lands a few ms after the first while `waitFor` samples
    // every 50 ms.
    await waitFor(() => expect(vi.mocked(sendPrompt)).toHaveBeenCalled());
    await flush();
    expect(vi.mocked(sendPrompt)).toHaveBeenCalledTimes(1);
  });

  it("send is fail-closed without the capability", async () => {
    seedLiveSession(); // capabilities {}
    render(<ChatStream />);
    // Task 4: NOT staged (the helper returns `true` — default paste).
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // A 2-arg call with NO images argument, even though a `File` was on the
    // clipboard (the `imageCapable` guard in `send()`).
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith("s1", "text"),
    );
  });

  // --- Mid-read races: the composer is NOT locked until `beginTurn` (which
  // runs only AFTER the FileReader `await`), so the session can switch and
  // thumbnails can be removed DURING the read. `send()` must reconcile
  // against the LIVE state after the `await`, not the stale closure. ---

  it("send is aborted if the session switches during the read", async () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hi" },
    });
    // Fake timers BEFORE the send: the read is macrotask-based in jsdom, so
    // faking the timer and advancing it settles the read deterministically
    // (a bare `waitFor` on a negative predicate would pass on the first poll
    // — false green — because the read hasn't settled yet).
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // SYNCHRONOUSLY (before the read settles) switch sessions — the same
    // `act` pattern as `switching sessions clears staged attachments`.
    await act(async () => {
      useSessions.setState({
        activeSessionId: "s2",
        sessions: [
          {
            sessionId: "s2",
            cwd: "/home/u/proj",
            capabilities: {},
            archived: false,
          },
        ],
      });
    });
    // Let the pending FileReader read settle (the continuation then runs and
    // sees the live `activeSessionIdRef` changed → aborts).
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    // `send()` aborted: it never reached `sendPrompt` (no send to the stale
    // `s1`).
    expect(vi.mocked(sendPrompt)).not.toHaveBeenCalled();
    // The draft is PRESERVED (the abort `return` runs before `setDraft("")`):
    // the textarea (now `s2`'s) still holds "hi".
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("hi");
    // NO user message was added to either session's transcript.
    const msgs = useSessions.getState().messages;
    expect((msgs.s1 ?? []).some((m) => m.kind === "user")).toBe(false);
    expect((msgs.s2 ?? []).some((m) => m.kind === "user")).toBe(false);
  });

  it("an image removed during the read is not sent", async () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // SYNCHRONOUSLY (before the FileReader resolves) remove the thumbnail —
    // the composer isn't locked until `beginTurn`, so the removal happens
    // during the read.
    fireEvent.click(
      screen.getByRole("button", { name: "Remove image attachment" }),
    );
    // `send()` is ASYNC (it awaits the FileReader read before `sendPrompt`) —
    // wait on the outcome (a 2-arg `sendPrompt` call, images filtered out),
    // never assert synchronously.
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith("s1", "text"),
    );
  });

  it("an image-only send with the image removed during the read sends nothing", async () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    // No text typed — an image-only send.
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // SYNCHRONOUSLY (before the read settles) remove the thumbnail.
    fireEvent.click(
      screen.getByRole("button", { name: "Remove image attachment" }),
    );
    // Let the pending FileReader read settle (the continuation then runs and
    // sees every image removed + no text → nothing left to send).
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    // `send()` aborted (nothing meaningful left to send): `sendPrompt` was
    // NEVER called. (A bare `waitFor` on the negative would be false green —
    // the fake-timer advance guarantees the read has settled first.)
    // WHICH guard catches this: removing the thumbnail also removes its
    // `[image #1]` marker (`removeAttachment` → `renumberImageMarkers`), so the
    // draft is empty by the time the read lands and the STALE-DRAFT GUARD
    // (`draftRef.current.trim() !== rawText`) aborts the send — it fires before
    // the images-empty block below, which no longer sees an empty text to
    // reject. Don't read the images-empty path as the only thing protecting an
    // image-only send: with markers in play the draft guard is the first line.
    expect(vi.mocked(sendPrompt)).not.toHaveBeenCalled();
  });

  it("a draft edited during the read is not sent and is not wiped", async () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "original" },
    });
    // Fake timers BEFORE the send: the read is macrotask-based in jsdom, so
    // faking the timer and advancing it settles the read deterministically
    // (a bare `waitFor` on a negative predicate would pass on the first poll
    // — false green — because the read hasn't settled yet).
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // SYNCHRONOUSLY (before the read settles) edit the draft — the composer
    // isn't locked until `beginTurn`, so the edit happens during the read.
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "original + more" },
    });
    // Let the pending FileReader read settle (the continuation then runs and
    // sees the live draft differs from the stale captured `text` → aborts).
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    // `send()` aborted (the draft changed during the read): `sendPrompt` was
    // NEVER called — neither the stale text nor the new one was sent.
    expect(vi.mocked(sendPrompt)).not.toHaveBeenCalled();
    // The NEW draft is PRESERVED (the abort `return` runs before
    // `setDraft("")`): the textarea still holds the edited text.
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "original + more",
    );
    // NO user message was added to the transcript.
    const msgs = useSessions.getState().messages;
    expect((msgs.s1 ?? []).some((m) => m.kind === "user")).toBe(false);
  });

  it("Esc while a turn is in flight calls cancelSession for the active session", async () => {
    seedLiveSession();
    render(<ChatStream />);
    // A turn is in flight (the composer is locked, `inTurn` true). The
    // re-render must settle BEFORE the keypress (the listener is registered
    // in an effect that runs on the re-render).
    useSessions.getState().beginTurn("s1");
    await act(async () => {});
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(vi.mocked(cancelSession)).toHaveBeenCalledWith("s1");
  });

  it("Esc with no turn in flight does NOT call cancelSession", async () => {
    seedLiveSession();
    render(<ChatStream />);
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(vi.mocked(cancelSession)).not.toHaveBeenCalled();
  });

  it("Esc while a turn is in flight of ANOTHER session does NOT call cancelSession", async () => {
    seedLiveSession();
    render(<ChatStream />);
    // The turn is in flight for a DIFFERENT session (not the active one):
    // the listener is gated on the ACTIVE session's `inTurn`, so it is
    // not active and nothing is cancelled.
    useSessions.getState().beginTurn("other");
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(vi.mocked(cancelSession)).not.toHaveBeenCalled();
  });

  it("Esc on a focused agent question card dismisses the card WITHOUT cancelling the turn", async () => {
    seedLiveSession();
    // A pending agent question (no `toolCallId` → not queued; unanchored →
    // the card takes focus on mount, so its root div is the focusable
    // element an Esc keypress lands on).
    useInteractive.getState().addRequest("s1", {
      requestId: "req-ask",
      method: "ask",
      source: "main",
      params: {
        questions: [
          {
            id: "q1",
            question: "Which approach?",
            options: [{ label: "A" }, { label: "B" }],
          },
        ],
      },
    });
    // A turn is in flight (the window Esc listener is active) — the Esc
    // meant for the card must NOT also cancel the turn.
    useSessions.getState().beginTurn("s1");
    render(<ChatStream />);
    // The listener is registered in an effect — settle the re-render
    // before the keypress.
    await act(async () => {});
    // The card root is the focusable element (`tabIndex={-1}`).
    const card = screen.getByText("Which approach?").closest(
      "[tabindex='-1']",
    );
    expect(card).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(card!, { key: "Escape" });
    });
    // The card's own Esc handler dismissed the request (cancelled)…
    await waitFor(() =>
      expect(useInteractive.getState().requests["s1"]).toHaveLength(0),
    );
    // …and the window listener did NOT fire (no `session/cancel`).
    expect(vi.mocked(cancelSession)).not.toHaveBeenCalled();
  });

  it("Esc on the sudo password modal's input dismisses the modal WITHOUT cancelling the turn", async () => {
    seedLiveSession();
    useInteractive.getState().addRequest("s1", {
      requestId: "req-pw",
      method: "password",
      source: "main",
      params: { command: "apt install ripgrep", reason: "install the tool" },
    });
    // A turn is in flight (the window Esc listener is active).
    useSessions.getState().beginTurn("s1");
    render(<ChatStream />);
    await act(async () => {});
    const input = screen.getByRole("textbox", { name: "Password" });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
    });
    // The modal's Esc handler dismissed the request (cancelled)…
    await waitFor(() =>
      expect(useInteractive.getState().requests["s1"]).toHaveLength(0),
    );
    // …and the window listener did NOT fire (no `session/cancel`).
    expect(vi.mocked(cancelSession)).not.toHaveBeenCalled();
  });

  it("a resumed session whose FRESH agent lacks image capability sends text-only without the staged image (no stale capability)", async () => {
    // The STORED session's SAVED capabilities advertise images (an older
    // agent) — so the paste is staged and the send button is enabled.
    seedStoredSession({ loadSession: true, promptCapabilities: { image: true } });
    // The FRESH agent (the resume result) does NOT advertise images.
    vi.mocked(resumeSession).mockResolvedValueOnce({
      sessionId: "s1",
      cwd: "/home/u/proj",
      capabilities: { loadSession: true },
      archived: false,
    });
    render(<ChatStream />);
    pasteToComposer(
      [new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" })],
    );
    expect(screen.getByAltText("s.png")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "look at this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(resumeSession).toHaveBeenCalledWith("s1", "/home/u/proj"),
    );
    // Fail-closed: the fresh agent can't take images → 2-arg send, the
    // image is NOT attached (and not sent a second time).
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith("s1", "look at this"),
    );
    expect(vi.mocked(sendPrompt)).toHaveBeenCalledTimes(1);
  });

  it("an image-only send on a resumed session whose FRESH agent lacks image capability is blocked (fail-closed)", async () => {
    seedStoredSession({ loadSession: true, promptCapabilities: { image: true } });
    vi.mocked(resumeSession).mockResolvedValueOnce({
      sessionId: "s1",
      cwd: "/home/u/proj",
      capabilities: { loadSession: true },
      archived: false,
    });
    render(<ChatStream />);
    pasteToComposer(
      [new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" })],
    );
    // No text — an image-only send (enabled by the SAVED capability).
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(resumeSession).toHaveBeenCalledWith("s1", "/home/u/proj"),
    );
    // Blocked: no prompt is sent (an empty prompt + unsent images is
    // meaningless — the same fail-closed posture as `!imageCapable`). With the
    // `[image #1]` marker now IN the draft this also pins that the guard sees a
    // marker-only draft as "no prose" (`draftIsMarkerOnly`) — otherwise the
    // marker alone would carry the prompt through to an agent that receives no
    // image at all.
    expect(vi.mocked(sendPrompt)).not.toHaveBeenCalled();
  });

  // --- Mentions: the `$`/`#`/`@`-trigger picker + the send-path expansion.
  // One picker, filtered to the active prefix's catalog; rows carry a prefix
  // badge. The send-path expansion assertions below are the `expandMentions`
  // regressions (all three catalogs).

  it("typing $ opens the mention picker with the skill rows ($ badge)", async () => {
    seedLiveSession();
    render(<ChatStream />);
    // A bare `$` (empty token remainder) opens the picker with the FULL list.
    // The catalog arrives via an ASYNC effect (the `listSkills` mock), so the
    // picker only renders once the fetch resolves — `findByText` awaits both
    // the fetch and the render.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "$" } });
    await screen.findByText("debug");
    // One row per skill, each with a `$` prefix badge (the generalization's
    // only visual delta vs the old skill picker).
    const picker = screen.getByTestId("mention-picker");
    expect(picker.querySelectorAll("button")).toHaveLength(2);
    // The prefix badge is the `text-ui-xs` span (the only such span per row).
    const firstBadge = picker.querySelector(".text-ui-xs")!;
    expect(firstBadge.textContent).toBe("$");
  });

  it("typing # opens the picker with the MCP rows (# badge)", async () => {
    seedLiveSession();
    seedMcpMentionsOn();
    render(<ChatStream />);
    // `#` → the ACTIVE prefix's catalog is the effective MCP servers (the
    // `listMcpServersEffective` mock). `findByText` awaits the async fetch.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "#" } });
    const row = await screen.findByText("postgres");
    // The `#` badge is on the row (the `@`/`$` glyphs must not mix in).
    expect(row.closest("button")!.querySelector(".text-ui-xs")!.textContent).toBe("#");
    // The skill catalog is NOT listed under `#` (no mixing).
    expect(screen.queryByText("debug")).toBeNull();
  });

  it("typing @ opens the picker with the agent rows (@ badge)", async () => {
    seedLiveSession();
    render(<ChatStream />);
    // `@` → the ACTIVE prefix's catalog is the agent definitions (the
    // `listAgentDefinitionsForSpace` mock). `findByText` awaits the async fetch.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "@" } });
    const row = await screen.findByText("scout");
    // The `@` badge is on the row (the `#`/`$` glyphs must not mix in).
    expect(row.closest("button")!.querySelector(".text-ui-xs")!.textContent).toBe("@");
    // Neither the MCP server nor a skill mixes in under `@`.
    expect(screen.queryByText("postgres")).toBeNull();
    expect(screen.queryByText("debug")).toBeNull();
  });

  it("a mixed draft lists only the prefix of the token at the caret", async () => {
    seedLiveSession();
    seedMcpMentionsOn();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    // The caret is at the END of what is typed (where a user's caret sits
    // after typing). Caret on the `$a` token → the picker is on the `$`
    // prefix: the skill row `beta` matches the `a` substring, and NO `#`/
    // `@` row mixes in (a `$`/`#`/`@` never mixes in one open list).
    fireEvent.change(textarea, { target: { value: "$a" } });
    expect(await screen.findByText("beta")).toBeTruthy();
    expect(screen.queryByText("postgres")).toBeNull();
    expect(screen.queryByText("scout")).toBeNull();
    // The user keeps typing to the `#pos` token: the picker flips to the `#`
    // prefix (the `postgres` server matches `pos`) and the `$` row drops out.
    fireEvent.change(textarea, { target: { value: "$a #pos" } });
    expect(await screen.findByText("postgres")).toBeTruthy();
    expect(screen.queryByText("beta")).toBeNull();
  });

  it("the picker filters as the token is typed", async () => {
    seedLiveSession();
    render(<ChatStream />);
    // `$de` → the single `debug` skill matches (the catalog is still loading
    // here — `findByText` awaits it).
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "$de" } });
    await screen.findByText("debug");
    // `$zzz` → no name contains `zzz` → the picker is not visible. The catalog
    // is already warm at this point, so no await is needed for the change.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "$zzz" } });
    expect(screen.queryByText("debug")).toBeNull();
  });

  it("enter selects the highlighted skill and inserts the token", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "$de" } });
    await screen.findByText("debug"); // catalog ready, picker open
    // The caret is at the END of the text (where a user's caret is after
    // typing — jsdom's `selectionStart` is 0 by default).
    textarea.setSelectionRange(3, 3);
    // Enter selects the highlighted row (`debug`) and inserts `$debug `.
    fireEvent.keyDown(textarea, { key: "Enter" });
    // The draft is local `useState` in `ChatStream` (NOT in any store) — read
    // it back from the TEXTAREA's `value` on the next render.
    expect(
      (screen.getByRole("textbox") as HTMLTextAreaElement).value,
    ).toBe("$debug ");
    // The picker is closed after selection.
    expect(screen.queryByText("debug")).toBeNull();
  });

  it("escape closes the picker without inserting", async () => {
    seedLiveSession();
    render(<ChatStream />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "$de" } });
    await screen.findByText("debug"); // catalog ready, picker open
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    // The picker is gone…
    expect(screen.queryByText("debug")).toBeNull();
    // …and the draft is UNCHANGED (no insertion).
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("$de");
  });

  it("send expands the mention before addUserMessage and sendPrompt", async () => {
    seedLiveSession();
    render(<ChatStream />);
    // Ensure the catalog is loaded (the expansion depends on it) — the picker
    // is NOT open here (the trailing space closes it), so `findByText` can't
    // be the wait signal.
    await waitForCatalog(listSkills);
    // The trailing space ends the active token → the picker is NOT open and
    // Enter is NOT intercepted by the picker's `selectMention` branch. `rawText`
    // = `draft.trim()` = `fix $debug`.
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "fix $debug " },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    // The expanded text (the exact pi-format block, Task 3).
    const expanded =
      'fix $debug\n\n<skill name="debug" location="/s/.agents/skills/debug/SKILL.md">' +
      "\nReferences are relative to /s/.agents/skills/debug." +
      "\n\nStep 1. Step 2.\n</skill>";
    // `addUserMessage` got the EXPANDED text (the live bubble = the agent
    // input — the REFINEMENT invariant).
    const msgs = useSessions.getState().messages["s1"];
    const userMsg = msgs?.find((m) => m.kind === "user");
    expect(userMsg).toBeTruthy();
    if (userMsg?.kind === "user") {
      expect(userMsg.text.startsWith("fix $debug")).toBe(true);
      expect(userMsg.text).toContain(
        '<skill name="debug" location="/s/.agents/skills/debug/SKILL.md">',
      );
      expect(userMsg.text).toContain(
        "References are relative to /s/.agents/skills/debug.",
      );
      expect(userMsg.text).toContain("Step 1. Step 2.");
      expect(userMsg.text).toBe(expanded);
    }
    // `sendPrompt` got the SAME expanded text (the 2-arg form — no images).
    expect(sendPrompt).toHaveBeenCalledWith("s1", expanded);
  });

  it("an unmatched token is sent verbatim", async () => {
    seedLiveSession();
    render(<ChatStream />);
    await waitForCatalog(listSkills);
    // `$nope` matches no skill → `expandMentions` finds no match and
    // returns the text UNCHANGED. The trailing space closes the picker.
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "hi $nope " },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    // `rawText` is `hi $nope` and nothing was expanded.
    expect(sendPrompt).toHaveBeenCalledWith("s1", "hi $nope");
  });

  // --- Task 6 (composer-mentions): `send()` expands via the THREE-catalog
  // `expandMentions` (the `@` agent / `#` MCP soft blocks alongside the
  // hard `$` skill block). ---

  it("send expands an @ agent mention into the soft agent block",
    async () => {
      seedLiveSession();
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "ping @scout " },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      // The EXACT agent-block literal (Task 3) — the `—` is an EM DASH.
      const expanded =
        "ping @scout\n\n" +
        '<agent name="scout">' +
        "\nscout \u2014 Fast recon." +
        '\nThe user has explicitly named the agent definition "scout" for this' +
        '\nrequest. Dispatch a subagent with agentName "scout" to handle it' +
        "\n(the definition's frontmatter defines its model, tools, and system" +
        "\nprompt; your explicit tool params layer over the definition)." +
        "\n</agent>";
      // The live bubble and the agent input carry the SAME text (the
      // `mergeDedupeKey` invariant).
      const userMsg = useSessions
        .getState()
        .messages["s1"]?.find((m) => m.kind === "user");
      expect(userMsg?.kind === "user" ? userMsg.text : null).toBe(expanded);
      expect(sendPrompt).toHaveBeenCalledWith("s1", expanded);
      // End-to-end (the `done-when`): the LIVE bubble the send just appended
      // renders the soft-hint chip, not the raw block text.
      expect(screen.getByText("named by the user")).toBeTruthy();
      expect(screen.queryByText(/Dispatch a subagent with agentName/)).toBeNull();
    });

  it("send expands a # MCP mention into the soft mcp block",
    async () => {
      seedLiveSession();
      seedMcpMentionsOn();
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "query #postgres " },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      const expanded =
        "query #postgres\n\n" +
        '<mcp name="postgres">' +
        '\nThe user has explicitly named the MCP server "postgres" for this' +
        '\nrequest. Connect to it via the mcp tool (mcp({ connect: "postgres" }))' +
        "\nand use its tools. (Server summary: npx -y x-mcp.)" +
        "\n</mcp>";
      expect(sendPrompt).toHaveBeenCalledWith("s1", expanded);
    });

  it("send expands a mixed $ / @ / # draft into blocks in first-mention order",
    async () => {
      seedLiveSession();
      seedMcpMentionsOn();
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "x $debug @scout #postgres " },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      const sent = vi.mocked(sendPrompt).mock.calls[0]![1] as string;
      expect(sent.startsWith("x $debug @scout #postgres")).toBe(true);
      // One block per kind, appended in TEXT order (first-mention order).
      const skill = sent.indexOf('<skill name="debug"');
      const agent = sent.indexOf('<agent name="scout">');
      const mcp = sent.indexOf('<mcp name="postgres">');
      expect(skill).toBeGreaterThan(-1);
      expect(agent).toBeGreaterThan(skill);
      expect(mcp).toBeGreaterThan(agent);
    });

  it("an unmatched # token passes through byte-identically into the sent text",
    async () => {
      seedLiveSession();
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      // `#nope` matches no MCP server → NO block and the token is NOT
      // stripped (the `mergeDedupeKey` byte-identity invariant).
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "hi #nope " },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      expect(sendPrompt).toHaveBeenCalledWith("s1", "hi #nope");
    });

  it("an unmatched @ token passes through byte-identically into the sent text",
    async () => {
      seedLiveSession();
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "hi @nope " },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      expect(sendPrompt).toHaveBeenCalledWith("s1", "hi @nope");
    });

  it("arrow_down_moves_the_highlight_and_enter_selects_the_second_row", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "$" } });
    await screen.findByText("debug"); // catalog ready, picker open (2 rows)
    const debugRow = screen.getByRole("button", { name: /debug/ });
    const betaRow = screen.getByRole("button", { name: /beta/ });
    // `debug` (index 0) is highlighted by default.
    expect(debugRow.className).toContain("bg-surface-hover");
    expect(betaRow.className).not.toContain("bg-surface-hover");
    // The caret is at the END of the text (where a user's caret is after
    // typing the `$` — jsdom's `selectionStart` is 0 by default).
    textarea.setSelectionRange(1, 1);
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    // The highlight moved to the `beta` row.
    expect(debugRow.className).not.toContain("bg-surface-hover");
    expect(betaRow.className).toContain("bg-surface-hover");
    // Enter selects the HIGHLIGHTED row (`beta`).
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("$beta ");
    expect(screen.queryByText("debug")).toBeNull();
  });

  it("arrow_up_wraps_around_to_the_last_row", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "$" } });
    await screen.findByText("debug"); // catalog ready, picker open (2 rows)
    const debugRow = screen.getByRole("button", { name: /debug/ });
    const betaRow = screen.getByRole("button", { name: /beta/ });
    textarea.setSelectionRange(1, 1);
    fireEvent.keyDown(textarea, { key: "ArrowUp" }); // wraps to the LAST row (index 1)
    expect(betaRow.className).toContain("bg-surface-hover");
    expect(debugRow.className).not.toContain("bg-surface-hover");
    fireEvent.keyDown(textarea, { key: "ArrowUp" }); // back to index 0
    expect(debugRow.className).toContain("bg-surface-hover");
    // Enter selects the FIRST row.
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("$debug ");
    expect(screen.queryByText("debug")).toBeNull();
  });

  it("tab_accepts_the_highlighted_candidate", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "$" } });
    await screen.findByText("debug"); // catalog ready, picker open
    textarea.setSelectionRange(1, 1);
    // Tab accepts the highlighted candidate (ZCode parity: `KEY_TAB_COMMAND`
    // → `selectOption(selectedIndex)` — the same handler Enter uses).
    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea.value).toBe("$debug ");
    expect(screen.queryByText("debug")).toBeNull();
  });

  it("tab_with_the_picker_closed_falls_through", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hello " } });
    // No `$` → the picker never opens.
    expect(screen.queryByText("debug")).toBeNull();
    // Tab is NOT intercepted (no `preventDefault` — `fireEvent` returns
    // `false` when the default was prevented) and the value is untouched.
    const notPrevented = fireEvent.keyDown(textarea, { key: "Tab" });
    expect(notPrevented).toBe(true);
    expect(textarea.value).toBe("hello ");
    expect(screen.queryByText("debug")).toBeNull();
  });

  it("enter_after_the_caret_leaves_the_token_closes_the_picker_instead_of_sending_or_swallowing", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    // `$debug` matches the `debug` skill → the picker is open, the token
    // active at the caret.
    fireEvent.change(textarea, { target: { value: "$debug" } });
    await screen.findByText("debug"); // picker open
    // Move the caret AWAY from the token WITHOUT `onChange` (a mouse click
    // or Home does this — no keystroke fires `change`): the picker is now
    // STALE (it would still `selectMention` the highlighted `debug` on Enter
    // if the keydown didn't re-evaluate the token at the caret).
    textarea.setSelectionRange(0, 0);
    fireEvent.keyDown(textarea, { key: "Enter" });
    // The stale picker must NOT swallow Enter: the picker closes AND the
    // message SENDS the draft as-typed (the send path expands the `$debug`
    // mention — the picker did not re-select or rewrite it: the verbatim
    // token stays in the text, the block is APPENDED by `send()`).
    // (The picker's CLOSED state is asserted via the picker's testid — the
    // skill's NAME now also renders in the sent message's collapsed skill
    // card header, so a text query is no longer a picker-only signal.)
    expect(screen.queryByTestId("mention-picker")).toBeNull();
    expect(textarea.value).toBe("");
    const sent =
      "$debug\n\n" +
      '<skill name="debug" location="/s/.agents/skills/debug/SKILL.md">' +
      "\nReferences are relative to /s/.agents/skills/debug." +
      "\n\nStep 1. Step 2.\n</skill>";
    expect(sendPrompt).toHaveBeenCalledWith("s1", sent);
  });

  it("shift_enter_inserts_a_newline_with_the_picker_open", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "$de" } });
    await screen.findByText("debug"); // picker open
    textarea.setSelectionRange(3, 3);
    // Shift+Enter must NOT be intercepted (no `preventDefault` — the
    // browser default inserts a newline; jsdom doesn't run it, so the
    // value only changes if the handler itself changes it).
    const notPrevented = fireEvent.keyDown(textarea, {
      key: "Enter",
      shiftKey: true,
    });
    expect(notPrevented).toBe(true);
    // NOT a skill selection (the draft is unchanged — not `$debug `) and
    // NOT swallowed.
    expect(textarea.value).toBe("$de");
    // Model the browser default (the newline lands): the token ends at the
    // newline → the picker closes on `onChange`.
    fireEvent.change(textarea, { target: { value: "$de\n" } });
    expect(textarea.value).toBe("$de\n");
    expect(screen.queryByText("debug")).toBeNull();
  });

  it("shift_tab_falls_through_with_the_picker_open", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "$de" } });
    await screen.findByText("debug"); // picker open, token active
    textarea.setSelectionRange(3, 3);
    // Shift+Tab must NOT be intercepted (a11y: it moves focus BACKWARD —
    // the browser default; intercepting it would be a keyboard trap). No
    // `preventDefault` (`fireEvent` returns `false` when the default was
    // prevented) and the draft is unchanged.
    const notPrevented = fireEvent.keyDown(textarea, {
      key: "Tab",
      shiftKey: true,
    });
    expect(notPrevented).toBe(true);
    expect(textarea.value).toBe("$de");
    // The picker is still open (no selection happened).
    expect(screen.getByTestId("mention-picker")).toBeTruthy();
  });

  it("the_insert_event_closes_the_picker", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    // The picker is open with a token active at the caret (the v1.1 flow:
    // the user typed `$x`, then clicks a SkillsDialog row).
    fireEvent.change(textarea, { target: { value: "$de" } });
    await screen.findByText("debug"); // picker open
    textarea.focus();
    textarea.setSelectionRange(3, 3); // caret at the end of the token
    // The `act` wrap is REQUIRED (the file's insert-event test convention):
    // a raw `dispatchEvent` does not flush React's state updates.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(IPC_EVENTS.insertSkill, { detail: "$beta " }),
      );
    });
    // The stale picker is CLOSED (no lingering popup until the next
    // keydown) …
    expect(screen.queryByTestId("mention-picker")).toBeNull();
    // …and the inserted text was spliced at the caret.
    expect(textarea.value).toBe("$de$beta ");
  });

  it("the left-pane insert event appends at the caret", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    // An existing draft, caret at the end (the focus + selection the event
    // reads from the ref/DOM).
    fireEvent.change(textarea, { target: { value: "hello " } });
    textarea.focus();
    textarea.setSelectionRange(6, 6);
    // The `act` wrap is REQUIRED: a raw `dispatchEvent` does not flush React's
    // state updates (the listener's `setDraft` would be invisible to a
    // synchronous assertion — the file's `fireEvent.paste` comment documents
    // this convention). No catalog dependency: the insert event is independent
    // of `listSkills`.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(IPC_EVENTS.insertSkill, { detail: "$debug " }),
      );
    });
    expect(textarea.value).toBe("hello $debug ");
  });

  // --- Task 5 (composer-mentions): the picker generalizes to `#` / `@`. ---

  it("enter selects an MCP row and inserts the #-token", async () => {
    seedLiveSession();
    seedMcpMentionsOn();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "#" } });
    await screen.findByText("postgres"); // catalog ready, picker open
    textarea.setSelectionRange(1, 1);
    // Enter selects the highlighted row and inserts `#postgres ` (LOWER-cased —
    // the inserted token must stay expandable).
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("#postgres ");
    expect(screen.queryByText("postgres")).toBeNull();
  });

  it("tab selects an agent row and inserts the @-token", async () => {
    seedLiveSession();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "@" } });
    await screen.findByText("scout"); // catalog ready, picker open
    textarea.setSelectionRange(1, 1);
    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea.value).toBe("@scout ");
    expect(screen.queryByText("scout")).toBeNull();
  });

  it("an unknown # token leaves the picker closed and the draft untouched", async () => {
    seedLiveSession();
    seedMcpMentionsOn();
    render(<ChatStream />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    // `#nosauch` matches no server in the catalog → no rows → the picker is
    // gated off (the token is untouched — no error, no stripping).
    fireEvent.change(textarea, { target: { value: "#nosauch" } });
    await waitFor(() => expect(vi.mocked(listMcpServersEffective)).toHaveBeenCalled());
    expect(screen.queryByTestId("mention-picker")).toBeNull();
    expect(textarea.value).toBe("#nosauch");
  });

  // --- Review follow-ups (F3/F4/F6): the lowercase-insertion policy, the
  // `filtered` memo's catalog deps, and the picker row affordances. ---

  it("a picker selection inserts the LOWER-cased token even for an uppercase catalog name",
    async () => {
      // The case policy: tokens are lowercase-only, so a picker-selected row
      // must insert `<prefix><name.toLowerCase()> ` or the inserted token
      // could never expand on send (the regex is lowercase-only). The
      // catalog name stays VERBATIM only inside the expanded BLOCK.
      vi.mocked(listAgentDefinitionsForSpace).mockResolvedValueOnce([
        { name: "Scout", description: "Fast recon.", model: null, scope: "user" },
      ]);
      seedLiveSession();
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "@" } });
      // The ROW shows the catalog name verbatim (`Scout`) …
      const row = await screen.findByText("Scout");
      expect(row.closest("button")).toBeTruthy();
      textarea.setSelectionRange(1, 1);
      // … but the INSERTED token is lowercased.
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "@scout ",
      );
    });

  it("a picker opened while the agents catalog is still loading shows the rows when the fetch resolves (no further keystroke)",
    async () => {
      // The `filtered` `useMemo` deps are `[skills, agents, mcpServers,
      // picker]`. Drop `agents` (or `mcpServers`) and the memo keeps the
      // EMPTY array it computed while the fetch was in flight — the picker
      // stays empty until the NEXT keystroke re-runs the memo.
      let resolveAgents: (rows: AgentDefinitionDto[]) => void = () => {};
      vi.mocked(listAgentDefinitionsForSpace).mockImplementationOnce(
        () => new Promise<AgentDefinitionDto[]>((r) => (resolveAgents = r)),
      );
      seedLiveSession();
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      // Open the picker on the `@` prefix while the agents fetch PENDING.
      fireEvent.change(textarea, { target: { value: "@" } });
      await waitFor(() =>
        expect(vi.mocked(listAgentDefinitionsForSpace)).toHaveBeenCalled(),
      );
      // Nothing to show yet (the fetch has not resolved).
      expect(screen.queryByTestId("mention-picker")).toBeNull();
      // The fetch resolves — and NO further keystroke happens.
      await act(async () => {
        resolveAgents([
          {
            name: "scout",
            description: "Fast recon.",
            model: null,
            scope: "user",
          },
        ]);
        await Promise.resolve();
      });
      const row = screen.getByText("scout");
      expect(row.closest("button")!.querySelector(".text-ui-xs")!.textContent).toBe(
        "@",
      );
      // And the late row is SELECTABLE (the memo recomputed the rows, not
      // just the render): Enter inserts it.
      textarea.setSelectionRange(1, 1);
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "@scout ",
      );
    });

  it("a mouse click on a # row inserts the token (mousedown, not click)",
    async () => {
      seedLiveSession();
      seedMcpMentionsOn();
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "#" } });
      const row = (await screen.findByText("postgres")).closest("button")!;
      textarea.focus();
      textarea.setSelectionRange(1, 1);
      // The row handles `onMouseDown` with `preventDefault` (so the textarea
      // never loses focus to the button) — a `click` would NOT select.
      const notPrevented = fireEvent.mouseDown(row);
      expect(notPrevented).toBe(false);
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "#postgres ",
      );
      // The picker closed after the mouse selection.
      expect(screen.queryByTestId("mention-picker")).toBeNull();
    });

  it("a # row's description (the MCP summary) renders as a title tooltip",
    async () => {
      seedLiveSession();
      seedMcpMentionsOn();
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "#" } });
      const row = (await screen.findByText("postgres")).closest("button")!;
      // The `#` catalog has no `description` field — the row's tooltip is the
      // server's one-line `summary`. Queried as the SECONDARY line, not as
      // "the first `[title]` in the row": the PRIMARY line carries a `title` too
      // (the full label of a truncated path), so the old proxy would have found
      // the name span and passed for the wrong reason.
      const desc = row.querySelector(".text-ui-sm")!;
      expect(desc.getAttribute("title")).toBe("npx -y x-mcp");
      expect(desc.textContent).toBe("npx -y x-mcp");
    });

  it("a mouse click on an @ row inserts the token (mousedown, not click)",
    async () => {
      seedLiveSession();
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "@" } });
      const row = (await screen.findByText("scout")).closest("button")!;
      textarea.focus();
      textarea.setSelectionRange(1, 1);
      // The `@` (agents) twin of the `#` test above: the row handles
      // `onMouseDown` with `preventDefault` (so the textarea never loses focus
      // to the button) — a `click` would NOT select.
      const notPrevented = fireEvent.mouseDown(row);
      expect(notPrevented).toBe(false);
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "@scout ",
      );
      // The picker closed after the mouse selection.
      expect(screen.queryByTestId("mention-picker")).toBeNull();
    });

  it("an @ row's TOOLTIP is its PRIMARY label (the name), never its secondary line",
    async () => {
      // The label span's `title` is what hover shows for a CLIPPED row, so it
      // must be the text the row renders FIRST. On a `?` row primary == the full
      // path (pinned in the long-path test); on a two-line row here they differ,
      // and that is the case that decides what `title` means: if it fell back to
      // `description`, the tooltip would duplicate the second line the row ALREADY
      // shows, and the primary text — the one that can be clipped — would have no
      // tooltip at all.
      seedLiveSession();
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "@" } });
      const row = (await screen.findByText("scout")).closest("button")!;
      const label = row.querySelector(".text-ui-base")!;
      // The elision pair, on a row that renders TWO lines: the Mention rows carry
      // paths too (an agent file's `display`), and the same flex/overflow
      // reasoning applies to them, not only to `?` rows.
      expect(label.className).toContain("min-w-0");
      expect(label.className).toContain("truncate");
      expect(label.getAttribute("title")).toBe("scout");
      expect(label.getAttribute("title")).not.toBe("Fast recon.");
      // And the secondary line keeps its OWN tooltip (it truncates too), so the
      // two lines are independently readable on hover.
      const desc = row.querySelector(".text-ui-sm")!;
      expect(desc.getAttribute("title")).toBe("Fast recon.");
    });

  it("an @ row's description (the agent description) renders as a title tooltip",
    async () => {
      seedLiveSession();
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "@" } });
      const row = (await screen.findByText("scout")).closest("button")!;
      // The `@` catalog DOES have a `description` field — the row's tooltip is
      // the agent definition's description verbatim. See the `#` test above for
      // why this is the SECONDARY line and not "the first `[title]`".
      const desc = row.querySelector(".text-ui-sm")!;
      expect(desc.getAttribute("title")).toBe("Fast recon.");
      expect(desc.textContent).toBe("Fast recon.");
    });

  // ---------------------------------------------------------------------
  // The `#` MCP-mention toggle (ADR 0031's follow-up). `#` is the ONE prefix
  // that collides with pasted developer text (`#include`, `#123`, `#hashtag`
  // all satisfy the token grammar), so the trigger is opt-in. The gate is
  // expressed as an EMPTY MCP catalog: the picker and the expansion are
  // already catalog-gated, so no new code path exists. The DISPLAY side
  // (`splitMentionBlocks`) is deliberately NOT gated — a message persisted
  // while the trigger was on keeps rendering its chip.
  // ---------------------------------------------------------------------

  it("the # trigger is OFF by default: typing # opens no picker", async () => {
    seedLiveSession();
    seedMcpMentionsOff();
    render(<ChatStream />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "#" } });
    // The MCP fetch HAS run (the fetch is NOT gated — gating it would make a
    // live toggle require a remount), but no rows are fed to the picker.
    await waitFor(() =>
      expect(vi.mocked(listMcpServersEffective)).toHaveBeenCalled(),
    );
    await flush();
    expect(screen.queryByTestId("mention-picker")).toBeNull();
    expect(screen.queryByText("postgres")).toBeNull();
  });

  it("with the # trigger OFF, a matching # token is sent BYTE-IDENTICAL (no expansion)",
    async () => {
      seedLiveSession();
      seedMcpMentionsOff();
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      // `postgres` IS in the catalog — the OFF state must still leave the text
      // untouched (the empty-catalog gate hits `expandMentions`, which then
      // finds no match and returns the text verbatim: invariant 1).
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "query #postgres " },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      expect(sendPrompt).toHaveBeenCalledWith("s1", "query #postgres");
      const userMsg = useSessions
        .getState()
        .messages["s1"]?.find((m) => m.kind === "user");
      expect(userMsg?.kind === "user" ? userMsg.text : null).toBe(
        "query #postgres",
      );
      // And the bubble renders no chip (the text carried no block).
      expect(screen.queryByText("named by the user")).toBeNull();
    });

  it("with the # trigger OFF, Enter with a bare # draft SENDS it (no swallowed keys)",
    async () => {
      seedLiveSession();
      seedMcpMentionsOff();
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "#123" } });
      await flush();
      // No picker → the keyboard branches (all gated on `filtered.length > 0`)
      // are inert, so Enter is a plain send. `#123` is exactly the pasted-issue
      // number that must reach the agent untouched.
      textarea.setSelectionRange(4, 4);
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      expect(sendPrompt).toHaveBeenCalledWith("s1", "#123");
    });

  it("with the # trigger OFF, the $ and @ triggers still pick and expand (only # is gated)",
    async () => {
      seedLiveSession();
      seedMcpMentionsOff();
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      // The pickers: `@` still opens (the `@` catalog is untouched).
      fireEvent.change(textarea, { target: { value: "@" } });
      expect(await screen.findByText("scout")).toBeTruthy();
      // And a MIXED draft expands `$` + `@` but NOT `#` — one block per
      // ENABLED kind, in first-mention order, with the `#` token left verbatim
      // in the user's text.
      fireEvent.change(textarea, {
        target: { value: "x $debug @scout #postgres " },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      const sent = vi.mocked(sendPrompt).mock.calls[0]![1] as string;
      expect(sent.startsWith("x $debug @scout #postgres")).toBe(true);
      expect(sent).toContain('<skill name="debug"');
      expect(sent).toContain('<agent name="scout">');
      expect(sent).not.toContain('<mcp name="postgres">');
    });

  it("the # trigger is gated while the settings are still loading (the fail-safe default)",
    async () => {
      // No settings seeded at all (`settings === null`) — the composer must
      // behave as OFF, never as ON (`settings?.mcpMentionsEnabled ?? false`).
      seedLiveSession();
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "query #postgres " },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      expect(sendPrompt).toHaveBeenCalledWith("s1", "query #postgres");
      expect(screen.queryByTestId("mention-picker")).toBeNull();
    });

  it("flipping the setting while the # picker is open feeds the rows without a remount",
    async () => {
      // The `filtered` memo's deps include the flag: the picker is open on `#`
      // (no rows, so nothing renders), and flipping the store to ON makes the
      // row appear with NO further keystroke and NO remount.
      seedLiveSession();
      seedMcpMentionsOff();
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "#" } });
      await waitFor(() =>
        expect(vi.mocked(listMcpServersEffective)).toHaveBeenCalled(),
      );
      await flush();
      expect(screen.queryByTestId("mention-picker")).toBeNull();
      await act(async () => {
        seedMcpMentionsOn();
      });
      expect((await screen.findByText("postgres")).closest("button")).toBeTruthy();
    });

  it("a persisted <mcp> block still renders its chip with the # trigger OFF (display is not gated)",
    () => {
      // The gate is on the TRIGGER, not the display: a message sent while the
      // toggle was ON keeps rendering its soft-hint chip after the toggle goes
      // OFF (the record is unchanged, and `mergeDedupeKey` must stay stable).
      seedLiveSession();
      seedMcpMentionsOff();
      useSessions
        .getState()
        .addUserMessage("s1", PERSISTED_MCP_MESSAGE);
      render(<ChatStream />);
      expect(screen.getByText("named by the user")).toBeTruthy();
      expect(screen.getByText("postgres")).toBeTruthy();
      // The user's own text renders without the block prose.
      expect(screen.queryByText(/Connect to it via the mcp tool/)).toBeNull();
    });
  // ---------------------------------------------------------------------
  // `?` File completion (ADR 0033) — the FOURTH picker prefix, and the ONLY
  // one that is NOT a Mention: selecting a row inserts a PATH (the trigger is
  // CONSUMED, the case is PRESERVED) and the send path expands NOTHING. The
  // block below pins the rows, the insertion policy, the render cap, the note,
  // and the two degradations (in-flight listing / no-match note).
  //
  // BEFORE these tests exist, `filtered` has no `?` branch, so a `?` token
  // falls through to the SKILLS catalog — which is exactly the transient state
  // these tests are written to catch.
  // ---------------------------------------------------------------------

  // The picker's row `<button>` whose PRIMARY line is `name` — the
  // `text-ui-base` span. A `?` row's button holds TWO spans on the primary
  // line (the `text-ui-xs` prefix badge and the name), so "the row has one
  // span" is never the right assertion; single-liness is pinned by the
  // ABSENCE of the description node (see the single-line test below).
  async function findFileRow(name: string): Promise<HTMLButtonElement> {
    const matches = await screen.findAllByText(name);
    const primary = matches.find((el) => el.classList.contains("text-ui-base"));
    return primary!.closest("button") as HTMLButtonElement;
  }

  it("typing ?RE opens the picker with the file rows and a ? badge", async () => {
    seedLiveSession();
    vi.mocked(listSpaceListing).mockResolvedValue({
      entries: ["README.md", "docs/plan.md"],
      truncated: false,
    });
    render(<ChatStream />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "?RE" } });
    const row = await findFileRow("README.md");
    // The `?` badge (the picker renders `row.prefix`, so `?` needs no new
    // markup) …
    expect(row.querySelector(".text-ui-xs")!.textContent).toBe("?");
    // … and NO skill row mixes in (the fall-through bug: `?` listed skills).
    expect(screen.queryByText("debug")).toBeNull();
    expect(screen.queryByText("beta")).toBeNull();
  });

  it("a path-shaped ? query matches by subsequence, not substring", async () => {
    seedLiveSession();
    vi.mocked(listSpaceListing).mockResolvedValue({
      entries: ["src/components/Formula.tsx", "README.md"],
      truncated: false,
    });
    render(<ChatStream />);
    // `src/comp/Form` is NOT a substring of `src/components/Formula.tsx` — a
    // path query is path-SHAPED, which is why the `?` branch filters with
    // `fuzzyMatch` (a subsequence match) instead of `includes`.
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "?src/comp/Form" },
    });
    expect(await findFileRow("src/components/Formula.tsx")).toBeTruthy();
    // `README.md` matches nothing in that query, so it is not listed.
    expect(screen.queryAllByText("README.md")).toEqual([]);
  });

  it("enter on a file row inserts the path with the ? CONSUMED and the CASE INTACT",
    async () => {
      seedLiveSession();
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["README.md"],
        truncated: false,
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      // The ADR's own example: the query is case-INSENSITIVE, the INSERTED path
      // carries the real name.
      fireEvent.change(textarea, { target: { value: "?REA" } });
      expect(await findFileRow("README.md")).toBeTruthy();
      textarea.setSelectionRange(4, 4);
      fireEvent.keyDown(textarea, { key: "Enter" });
      // NOT `?README.md ` (the trigger is consumed) and NOT `readme.md `
      // (the insertion is VERBATIM — no lowercasing rule applies to a path, so
      // the Mention lowercase-only rule does NOT apply to `?`. The path is
      // then ordinary draft text and obeys the mention grammar like
      // hand-typed text — ADR 0033).
      expect(
        (screen.getByRole("textbox") as HTMLTextAreaElement).value,
      ).toBe("README.md ");
      expect(screen.queryByTestId("mention-picker")).toBeNull();
    });

  it("tab on a file row inserts the path (trigger consumed, case intact)",
    async () => {
      seedLiveSession();
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["src/README.md"],
        truncated: false,
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?src/READ" } });
      expect(await findFileRow("src/README.md")).toBeTruthy();
      textarea.setSelectionRange(9, 9);
      fireEvent.keyDown(textarea, { key: "Tab" });
      expect(
        (screen.getByRole("textbox") as HTMLTextAreaElement).value,
      ).toBe("src/README.md ");
    });

  it("a mousedown on a file row inserts the path (trigger consumed, case intact)",
    async () => {
      seedLiveSession();
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["README.md"],
        truncated: false,
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?REA" } });
      const row = await findFileRow("README.md");
      textarea.focus();
      textarea.setSelectionRange(4, 4);
      // `onMouseDown` (with `preventDefault`) is the row's handler — a `click`
      // would NOT select (the same affordance as the Mention rows).
      const notPrevented = fireEvent.mouseDown(row);
      expect(notPrevented).toBe(false);
      expect(
        (screen.getByRole("textbox") as HTMLTextAreaElement).value,
      ).toBe("README.md ");
      expect(screen.queryByTestId("mention-picker")).toBeNull();
    });

  it("a file row is a single line: no basename second line, no tooltip, full path still shown",
    async () => {
      seedLiveSession();
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["src/nested/README.md"],
        truncated: false,
      });
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "?src/nested/READ" },
      });
      const row = await findFileRow("src/nested/README.md");
      // The PRIMARY line is the full Space-RELATIVE path — what gets INSERTED
      // for a **Listing** row, so it must never be shortened to the basename
      // (`selectMention` inserts `row.name`). An OUT-OF-SPACE row shows its
      // abbreviated `label` here instead while still inserting `name` — pinned by
      // the ADR 0035 describe below, not by this test.
      expect(row.querySelector(".text-ui-base")!.textContent).toBe(
        "src/nested/README.md",
      );
      // And there is NO secondary line. The basename used to be repeated there
      // — the tail of the path already shown above it — which made every `?`
      // row two lines tall (≈49px) for ZERO information. `ComposerMentions`
      // renders the second line only when `description !== ""`, so the
      // description node — and with it the DESCRIPTION's tooltip — is absent.
      // Asserted ON THE LINE, not as "`[title]` is absent": the primary line has
      // carried its own full-label `title` since the truncation work, so the old
      // proxy was simply false, and it would have failed to catch a description
      // that grew back while some other span had a tooltip.
      expect(row.querySelector(".text-ui-sm")).toBeNull();
      expect(row.querySelectorAll("[title]")).toHaveLength(1);
      // Pinned against the wrong "fix" (dropping `name` instead of
      // `description`): the row still has its prefix badge and its name span.
      expect(row.querySelector(".text-ui-xs")!.textContent).toBe("?");
    });

  it("a truncated listing shows the cap note, which is NOT a selectable row, and Enter still sends",
    async () => {
      seedLiveSession();
      // Truncated AND nothing matches: the note is exactly what explains the
      // EMPTY picker (the container gate widened to `open && (rows || note)`).
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["README.md"],
        truncated: true,
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?zzzz" } });
      const picker = await screen.findByTestId("mention-picker");
      const note = picker.querySelector(
        "[data-testid='mention-picker-note']",
      )!;
      // NO number in the string: the DTO carries only `truncated`, so naming
      // the Rust `MAX_PICKER_ENTRIES` here would let the UI lie the moment the
      // Rust cap moves (ADR 0033's note is qualitative on purpose).
      // And NO "keep typing" advice: the walk is deterministic
      // (`sort_by_file_name`), so a truncated listing holds the alphabetically
      // FIRST 5,000 entries and a truncated-away file is unreachable by
      // narrowing — advising it would be a lie.
      expect(note.textContent).toBe(
        "Listing capped — some files may be missing",
      );
      // The note is NEVER a row: it is not in the button set `activeIndex`,
      // the arrow-wrap and Enter operate over.
      expect(picker.querySelectorAll("button")).toHaveLength(0);
      expect(note.tagName).not.toBe("BUTTON");
      // And Enter still SENDS — the keydown intercept is gated on
      // `filtered.length > 0`, which the note does not touch.
      textarea.setSelectionRange(6, 6);
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(sendPrompt).toHaveBeenCalledWith("s1", "?zzzz");
    });

  it("a query matching more rows than the render cap trims the list and says so",
    async () => {
      seedLiveSession();
      // 150 matching entries against the 10-row render cap (`MAX_PICKER_ROWS`):
      // `fuzzyMatch` is a loose subsequence and the listing is the whole Space,
      // so an unbounded picker would re-render thousands of buttons per
      // keystroke — and 10 single-line rows is ≈308px, a normal dropdown.
      const entries = Array.from({ length: 150 }, (_, i) => `file${i}.ts`);
      vi.mocked(listSpaceListing).mockResolvedValue({ entries, truncated: false });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?file" } });
      const picker = await screen.findByTestId("mention-picker");
      await waitFor(() => expect(picker.querySelectorAll("button")).toHaveLength(10));
      const note = picker.querySelector(
        "[data-testid='mention-picker-note']",
      )!;
      expect(note.textContent).toContain("Too many matches");
      // The wrap stays consistent with the RENDERED list (the cap is applied
      // INSIDE `filtered`, so `activeIndex`, the `% filtered.length` wrap and
      // the DOM agree): ArrowUp from index 0 wraps to the LAST rendered row.
      textarea.setSelectionRange(5, 5);
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      const buttons = Array.from(picker.querySelectorAll("button"));
      expect(buttons[9]!.className).toContain("bg-surface-hover");
      expect(buttons[0]!.className).not.toContain("bg-surface-hover");
      // And the wrapped row is selectable (no crash on the capped tail).
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(
        (screen.getByRole("textbox") as HTMLTextAreaElement).value,
      ).toBe("file9.ts ");
    });

  it("a normal ? picker with matching rows and a whole listing renders NO note",
    async () => {
      seedLiveSession();
      // The `undefined` arm: nothing is capped and nothing is truncated, so
      // the picker must stay silent (a note here would be noise on the
      // everyday path).
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["README.md", "docs/plan.md"],
        truncated: false,
      });
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "?READ" },
      });
      const picker = await screen.findByTestId("mention-picker");
      expect(picker.querySelectorAll("button")).toHaveLength(1);
      expect(
        screen.queryByTestId("mention-picker-note"),
      ).toBeNull();
    });

  it("a truncated listing with matching rows shows the note ALONGSIDE the rows, and the note is not a row",
    async () => {
      seedLiveSession();
      // The other half of the widened gate: the note is NOT only an
      // empty-picker explanation — it rides along whenever the listing is
      // capped, rows or not. Below the render cap (5 matches < 10), so the
      // wording is the walk-cap one.
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["a1.ts", "a2.ts", "a3.ts", "a4.ts", "a5.ts"],
        truncated: true,
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      // ≥1 path char after the trigger (a bare `?` opens nothing, ADR 0033).
      fireEvent.change(textarea, { target: { value: "?a" } });
      const picker = await screen.findByTestId("mention-picker");
      const note = screen.getByTestId("mention-picker-note");
      // The walk-cap arm states the LIMITATION — no "keep typing" advice (a
      // truncated-away file cannot be reached by narrowing).
      expect(note.textContent).toBe(
        "Listing capped — some files may be missing",
      );
      expect(note.textContent).not.toContain("keep typing");
      // The rows are all still there (the note never replaces them) …
      const buttons = Array.from(picker.querySelectorAll("button"));
      expect(buttons).toHaveLength(5);
      // … and the note is outside the button set `activeIndex` / the
      // arrow-wrap / Enter operate over.
      expect(buttons).not.toContain(note);
      expect(note.tagName).not.toBe("BUTTON");
      expect(picker.contains(note)).toBe(true);
      // Arrow navigation still lands on a row, never on the note. The caret is
      // at the END of the token (the keydown re-evaluates it: a caret INSIDE
      // `?a` at index 1 leaves an empty remainder, which is not a `?` token).
      textarea.setSelectionRange(2, 2);
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      expect(
        Array.from(picker.querySelectorAll("button"))[4]!.className,
      ).toContain("bg-surface-hover");
    });

  it("a truncated listing AND more matches than the render cap: the too-many-matches wording wins",
    async () => {
      seedLiveSession();
      // Precedence pin: both conditions hold, and the actionable one (keep
      // typing) is what renders — the walk-cap note is shadowed.
      const entries = Array.from({ length: 150 }, (_, i) => `file${i}.ts`);
      vi.mocked(listSpaceListing).mockResolvedValue({ entries, truncated: true });
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "?file" },
      });
      const picker = await screen.findByTestId("mention-picker");
      await waitFor(() =>
        expect(picker.querySelectorAll("button")).toHaveLength(10),
      );
      const note = screen.getByTestId("mention-picker-note");
      expect(note.textContent).toBe(
        "Too many matches — keep typing to narrow the list",
      );
      expect(note.textContent).not.toContain("capped");
    });

  it.each([
    { prefix: "$" as const, kind: "skills" as const },
    { prefix: "@" as const, kind: "agents" as const },
    { prefix: "#" as const, kind: "mcp" as const },
  ])(
    "the $prefix picker is UNCAPPED and note-free with more matches than the render cap ($kind catalog)",
    async ({ prefix, kind }) => {
      seedLiveSession();
      // The render cap belongs to `?` ALONE (its loose SUBSEQUENCE filter can
      // match nearly a whole 5,000-entry listing). The three Mentions keep the
      // shipped status quo: their filter is a name SUBSTRING, and ADR 0033
      // promises those pickers are unchanged — a silent 10-row cap there
      // would make row 11 unreachable with no explanation.
      // `…Once` (not `…Value`): `beforeEach` only `clearAll`s the mocks, so a
      // PERSISTENT override would leak this catalog into later tests.
      if (prefix === "#") seedMcpMentionsOn();
      const many = Array.from({ length: 150 }, (_, i) => `${kind}${i}`);
      if (kind === "skills") {
        vi.mocked(listSkills).mockResolvedValueOnce(
          many.map((name) => ({
            name,
            description: `d ${name}`,
            path: `/s/${name}/SKILL.md`,
            dir: `/s/${name}`,
            scope: "space",
            body: "B",
            disableModelInvocation: false,
            shadowed: [],
          })),
        );
      } else if (kind === "agents") {
        vi.mocked(listAgentDefinitionsForSpace).mockResolvedValueOnce(
          many.map((name) => ({
            name,
            description: `d ${name}`,
            model: null,
            scope: "user",
          })),
        );
      } else {
        vi.mocked(listMcpServersEffective).mockResolvedValueOnce(
          many.map((name) => ({ name, kind: "stdio", summary: `s ${name}` })),
        );
      }
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: prefix } });
      const picker = await screen.findByTestId("mention-picker");
      await waitFor(() =>
        // ALL 150 matches render — nothing is silently dropped.
        expect(picker.querySelectorAll("button")).toHaveLength(150),
      );
      expect(screen.queryByTestId("mention-picker-note")).toBeNull();
      // And the last row is reachable: the arrow-wrap counts the rendered
      // rows, so ArrowUp from index 0 lands on row 150 (index 149).
      textarea.setSelectionRange(1, 1);
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      const buttons = Array.from(picker.querySelectorAll("button"));
      expect(buttons[149]!.className).toContain("bg-surface-hover");
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(
        (screen.getByRole("textbox") as HTMLTextAreaElement).value,
      ).toBe(`${prefix}${many[149]} `);
    },
  );

  it("while the file listing is in flight, ? opens NO picker and Enter SENDS",
    async () => {
      seedLiveSession();
      // A skill whose name matches the query SUBSTRING: while the `?` branch is
      // missing this renders a skills picker (and Enter INSERTS instead of
      // sending) — the degradation this test pins is "no rows at all".
      vi.mocked(listSkills).mockResolvedValueOnce([
        {
          name: "debug",
          description: "Debug a failure",
          path: "/s/debug/SKILL.md",
          dir: "/s/debug",
          scope: "space",
          body: "B",
          disableModelInvocation: false,
          shadowed: [],
        },
      ]);
      // A DEFERRED listing: the in-flight state ADR 0033 calls out (an empty
      // `filtered` means no picker and inert keyboard branches, so Enter sends
      // — the same degradation ADR 0032 relies on).
      let resolveFiles: (v: ListingDto) => void = () => {};
      vi.mocked(listSpaceListing).mockImplementation(
        () => new Promise<ListingDto>((r) => (resolveFiles = r)),
      );
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      await waitFor(() => expect(vi.mocked(listSpaceListing)).toHaveBeenCalled());
      await waitFor(() => expect(vi.mocked(listSkills)).toHaveBeenCalled());
      fireEvent.change(textarea, { target: { value: "hi ?de" } });
      expect(screen.queryByTestId("mention-picker")).toBeNull();
      textarea.setSelectionRange(7, 7);
      fireEvent.keyDown(textarea, { key: "Enter" });
      // Sent, and BYTE-IDENTICAL: no block appended, nothing stripped.
      expect(sendPrompt).toHaveBeenCalledWith("s1", "hi ?de");
      // The late listing lands with NO further keystroke (the `files` dep on
      // the `filtered` memo), and it must not resurrect a picker for a token
      // that no longer exists in the (now-empty) draft.
      await act(async () => {
        resolveFiles({ entries: ["README.md"], truncated: false });
        await Promise.resolve();
      });
      expect(screen.queryByTestId("mention-picker")).toBeNull();
      expect(screen.queryAllByText("README.md")).toEqual([]);
    });

  it("a Space switch serves no file rows until the new Space listing resolves",
    async () => {
      // Two live sessions in DIFFERENT Spaces (the catalog is keyed by the
      // Space path, so switching sessions is a catalog KEY change).
      useSessions.setState({
        activeSessionId: "s1",
        sessions: [
          { sessionId: "s1", cwd: "/home/u/proj", capabilities: {}, archived: false },
          { sessionId: "s2", cwd: "/home/u/other", capabilities: {}, archived: false },
        ],
        spaces: [
          { path: "/home/u/proj", createdAt: 1, lastOpenedAt: 1, trusted: false },
          { path: "/home/u/other", createdAt: 1, lastOpenedAt: 1, trusted: false },
        ],
        historySessions: [],
        messages: { s1: [], s2: [] },
        inTurn: {},
        stopReasons: {},
        closeReasons: {},
        configOptions: {},
      });
      let resolveOther: (v: ListingDto) => void = () => {};
      vi.mocked(listSpaceListing).mockImplementation((p) =>
        p === "/home/u/proj"
          ? Promise.resolve({ entries: ["README.md"], truncated: false })
          : new Promise<ListingDto>((r) => (resolveOther = r)),
      );
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "?README" } });
      expect(await findFileRow("README.md")).toBeTruthy();
      // Switch the Space WHILE the picker is open: the old Space's rows must
      // NOT be offered against the new one (a stale row would insert a path the
      // new Space does not have).
      await act(async () => {
        useSessions.setState({ activeSessionId: "s2" });
      });
      await flush();
      expect(screen.queryAllByText("README.md")).toEqual([]);
      expect(screen.queryByTestId("mention-picker")).toBeNull();
      // The new listing resolves; the picker is still closed (the draft never
      // changed, so no `onChange` re-ran), and a fresh query offers ONLY the
      // new Space's file.
      await act(async () => {
        resolveOther({ entries: ["OTHER.md"], truncated: false });
        await Promise.resolve();
      });
      fireEvent.change(textarea, { target: { value: "?OTHER" } });
      expect(await findFileRow("OTHER.md")).toBeTruthy();
      expect(screen.queryAllByText("README.md")).toEqual([]);
    });

  it("a ? path in the draft is sent BYTE-IDENTICAL (never expanded, never stripped)",
    async () => {
      seedLiveSession();
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["README.md"],
        truncated: false,
      });
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      // `README.md` IS in the listing — the send path must still leave the text
      // untouched (`expandMentions` never sees `?`; the trailing space also
      // closes the token, so Enter is not an insertion).
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "read ?README.md " },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      expect(sendPrompt).toHaveBeenCalledWith("s1", "read ?README.md");
      const userMsg = useSessions
        .getState()
        .messages["s1"]?.find((m) => m.kind === "user");
      expect(userMsg?.kind === "user" ? userMsg.text : null).toBe(
        "read ?README.md",
      );
      // And no Mention chip was rendered for it (no block was appended).
      expect(screen.queryByText("named by the user")).toBeNull();
    });

  it("??, a?.b and a bare ? open NO picker and all three drafts SEND verbatim",
    async () => {
      seedLiveSession();
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["README.md"],
        truncated: false,
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      await waitForCatalog(listSkills);
      const drafts = ["?? README.md", "a?.b", "?"];
      for (const [i, d] of drafts.entries()) {
        fireEvent.change(textarea, { target: { value: d } });
        await flush();
        // None is a `?` token (`??` and a bare `?` need ≥1 path char; `a?.b`
        // fails the `(^|\s)` boundary) — so no picker and Enter stays a SEND.
        expect(screen.queryByTestId("mention-picker")).toBeNull();
        textarea.setSelectionRange(d.length, d.length);
        fireEvent.keyDown(textarea, { key: "Enter" });
        await waitFor(() =>
          expect(sendPrompt).toHaveBeenNthCalledWith(i + 1, "s1", d),
        );
        // Unlock the composer for the next iteration (the mocked send resolves
        // in a microtask; `turnCompleted` clears `inTurn`).
        await waitFor(() =>
          expect(useSessions.getState().inTurn["s1"]).toBe(false),
        );
      }
    });

  it("the $ and @ pickers still list and insert their lowercase mention tokens",
    async () => {
      // The regression pin: `?` SHARES the picker but not the semantics — the
      // Mention prefixes keep the substring filter AND the lowercase insertion.
      seedLiveSession();
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: ["README.md", "debug-notes.md"],
        truncated: false,
      });
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      // `$` → the skills catalog only (the file `debug-notes.md` must NOT mix
      // into a `$` list, even though it matches the query as a substring).
      fireEvent.change(textarea, { target: { value: "$de" } });
      expect(await screen.findByText("debug")).toBeTruthy();
      expect(screen.queryByText("debug-notes.md")).toBeNull();
      textarea.setSelectionRange(3, 3);
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "$debug ",
      );
      // `@` → the agents catalog, and the inserted token is still LOWER-cased.
      fireEvent.change(textarea, { target: { value: "@" } });
      const scout = await screen.findByText("scout");
      expect(
        scout.closest("button")!.querySelector(".text-ui-xs")!.textContent,
      ).toBe("@");
      textarea.setSelectionRange(1, 1);
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "@scout ",
      );
    });

  // ---------------------------------------------------------------------
  // Picker GEOMETRY: the box clamps its own height and scrolls, and the
  // highlighted row is scrolled into view as the arrows move it. This is what
  // bounds the UNCAPPED Mention lists (`$`/`@`/`#` are deliberately not
  // row-capped — a sliced row is an unreachable row), so the promise "the
  // picker never dominates the window" is geometry, not a row count.
  //
  // What jsdom CAN and cannot check: it has NO layout engine, so row heights
  // and scroll offsets are unmeasurable here (hence the clamp is a deliberate
  // ESTIMATE in the component, and these tests assert the CLASSES and the
  // SCROLL CALL, never a pixel height).
  // ---------------------------------------------------------------------

  it("the picker clamps its height to the UI font size and scrolls instead of filling the window",
    async () => {
      seedLiveSession();
      // Enough rows that the list is taller than the clamp: `?` is capped at
      // 10 rows, and the clamp is sized to ≈10 rows, so 10 rows plus the note
      // line is already more than the box can show.
      vi.mocked(listSpaceListing).mockResolvedValue({
        entries: Array.from({ length: 10 }, (_, i) => `file${i}.ts`),
        truncated: true,
      });
      render(<ChatStream />);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "?file" },
      });
      const picker = await screen.findByTestId("mention-picker");
      await waitFor(() =>
        expect(picker.querySelectorAll("button")).toHaveLength(10),
      );
      // It must SCROLL: without `overflow-y-auto` a `max-height` just clips.
      expect(picker.classList.contains("overflow-y-auto")).toBe(true);
      // And the clamp must track the UI font size, which is a USER setting
      // applied as an inline px value on `<html>` (`src/lib/settings.ts`) — a
      // fixed `rem` clamp like `max-h-64` would show FEWER rows for a user who
      // raised the font size, i.e. it punishes exactly the user who needs the
      // room. So the class is a `calc()` over `var(--ui-font-size)`.
      const clamp = Array.from(picker.classList).find((c) =>
        c.startsWith("max-h-["),
      );
      expect(clamp).toBeDefined();
      expect(clamp).toContain("var(--ui-font-size)");
    });

  it("arrow-keying the picker scrolls the highlighted row into view",
    async () => {
      seedLiveSession();
      // The UNCAPPED side: the `$` catalog is not row-limited, so this is the
      // list the clamp actually protects. 40 rows is far more than the box can
      // show, and every one of them stays keyboard-reachable.
      const many = Array.from({ length: 40 }, (_, i) => `skill${i}`);
      vi.mocked(listSkills).mockResolvedValueOnce(
        many.map((name) => ({
          name,
          description: `d ${name}`,
          path: `/s/${name}/SKILL.md`,
          dir: `/s/${name}`,
          scope: "space",
          body: "B",
          disableModelInvocation: false,
          shadowed: [],
        })),
      );
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "$" } });
      const picker = await screen.findByTestId("mention-picker");
      await waitFor(() =>
        expect(picker.querySelectorAll("button")).toHaveLength(40),
      );
      // Which ROW was scrolled is the whole question, and the tool for it is
      // the file's OWN `beforeAll` stub (`HTMLElement.prototype.scrollIntoView =
      // vi.fn()`, there for Radix) read through `mock.contexts` — the RECEIVER
      // of each call. Two alternatives were tried and are wrong here: a bare
      // "was `scrollIntoView` called" assertion could be satisfied by an
      // unrelated widget, and a per-row `vi.spyOn` cannot answer WHICH row —
      // `scrollIntoView` is INHERITED, so 40 spies chain through the same stub
      // and each records the one call.
      const scrollStub = HTMLElement.prototype.scrollIntoView as Mock;
      /** Every element ever asked to scroll, in call order. */
      const scrolled = (): Element[] =>
        scrollStub.mock.contexts as unknown as Element[];
      const buttons = Array.from(
        picker.querySelectorAll("button"),
      ) as HTMLButtonElement[];
      // Settle the in-flight catalogs BEFORE measuring, and wait until the log
      // goes quiet. The agents / MCP / file fetches land independently of the
      // skills one, and every resolution re-derives `filtered` — which
      // legitimately re-runs the effect for whatever row is active AT THAT
      // MOMENT (still row 0, before any arrow key). That is noise for a test
      // about what an ARROW KEY does, so the window starts after the quiet
      // point; there is then no `await` between a keypress and its assertion,
      // so nothing can interleave.
      let quietAt = -1;
      while (quietAt !== scrolled().length) {
        quietAt = scrolled().length;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      let mark = scrolled().length;

      textarea.setSelectionRange(1, 1);
      fireEvent.keyDown(textarea, { key: "ArrowDown" });

      // The row that is NOW highlighted (index 0 → 1) is the one scrolled into
      // view — focus-follows, so a keyboard user arrowing down a long list
      // never loses the selection off the top or bottom of the box. ONE scroll,
      // on the moved-to row, with `block: "nearest"` (what keeps an
      // already-visible row from jumping).
      const down = scrolled().slice(mark);
      expect(down).toEqual([buttons[1]]);
      expect(scrollStub.mock.calls[mark]![0]).toEqual({ block: "nearest" });
      expect(buttons[1]!.className).toContain("bg-surface-hover");

      // The row-above case, which is the one a ref-on-the-active-row can get
      // WRONG: ArrowUp moves the highlight BACK to a row that was mounted the
      // whole time, so a stale ref would scroll nothing (or the wrong row).
      mark = scrolled().length;
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      expect(scrolled().slice(mark)).toEqual([buttons[0]]);
      expect(scrollStub.mock.calls[mark]![0]).toEqual({ block: "nearest" });

      // And the WRAP: ArrowUp from index 0 lands on the LAST row — the one
      // furthest outside the visible box, so this is the scroll that matters
      // most.
      mark = scrolled().length;
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      expect(scrolled().slice(mark)).toEqual([buttons[39]]);
      expect(buttons[39]!.className).toContain("bg-surface-hover");
      // Still every row rendered: the clamp is GEOMETRY, never a slice of
      // `filtered` — nothing here may make a row unreachable.
      expect(picker.querySelectorAll("button")).toHaveLength(40);
    });

  it("typing narrows the list under an UNCHANGED index and the newly-active row is the one scrolled",
    async () => {
      // The pin for `filtered` being in the scroll effect's dep array (see
      // `ComposerMentions`' DEPS note). `filtered` is NOT there for the arrow
      // keys — the test above covers those — it is there for TYPING: `onChange`
      // resets `picker.index` to 0, so a keystroke that narrows the list leaves
      // `activeIndex` the SAME NUMBER (0) while `filtered[0]` becomes a
      // DIFFERENT row. Deps `[activeIndex]` alone therefore never re-run, and
      // the row the user is now on is never made visible — a silent
      // keyboard/a11y failure with no other test to catch it (mutation-verified:
      // dropping `filtered` from the array keeps every other test in this file
      // green).
      seedLiveSession();
      vi.mocked(listSkills).mockResolvedValueOnce([
        {
          name: "ab-alpha",
          description: "d a",
          path: "/s/ab-alpha/SKILL.md",
          dir: "/s/ab-alpha",
          scope: "space",
          body: "B",
          disableModelInvocation: false,
          shadowed: [],
        },
        {
          name: "ab-beta",
          description: "d b",
          path: "/s/ab-beta/SKILL.md",
          dir: "/s/ab-beta",
          scope: "space",
          body: "B",
          disableModelInvocation: false,
          shadowed: [],
        },
        {
          name: "ac-gamma",
          description: "d g",
          path: "/s/ac-gamma/SKILL.md",
          dir: "/s/ac-gamma",
          scope: "space",
          body: "B",
          disableModelInvocation: false,
          shadowed: [],
        },
      ]);
      render(<ChatStream />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "$ab" } });
      const picker = await screen.findByTestId("mention-picker");
      await waitFor(() =>
        expect(picker.querySelectorAll("button")).toHaveLength(2),
      );
      // The same receiver-reading technique as the arrow test above: the file's
      // own `beforeAll` stub, read through `mock.contexts`, because
      // `scrollIntoView` is INHERITED and a per-row `vi.spyOn` records the same
      // single call for every row.
      const scrollStub = HTMLElement.prototype.scrollIntoView as Mock;
      const scrolled = (): Element[] =>
        scrollStub.mock.contexts as unknown as Element[];
      // Quiet point: the agents / MCP / file catalogs resolve independently of
      // skills and each resolution re-runs the effect for the row active AT
      // THAT MOMENT. Wait the log stops growing, then leave no `await` between
      // the keystroke and the assertion.
      let quietAt = -1;
      while (quietAt !== scrolled().length) {
        quietAt = scrolled().length;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      const before = Array.from(
        picker.querySelectorAll("button"),
      ) as HTMLButtonElement[];
      // Precondition: index 0 is active and it is `ab-alpha`.
      expect(before[0]!.className).toContain("bg-surface-hover");
      const mark = scrolled().length;

      // The keystroke: one more character. `filtered` narrows to ONE row
      // (`ab-beta` — `ab-alpha` no longer matches) while `activeIndex` stays 0,
      // so the highlighted row is now a row that was NOT highlighted before.
      textarea.setSelectionRange(8, 8);
      fireEvent.change(textarea, { target: { value: "$ab-beta" } });

      const after = Array.from(
        picker.querySelectorAll("button"),
      ) as HTMLButtonElement[];
      expect(after).toHaveLength(1);
      expect(after[0]!.textContent).toContain("ab-beta");
      // `activeIndex` is UNCHANGED (still the first row), so this assertion
      // holds for the buggy and correct code alike — it is here to pin the
      // precondition, not to do the detecting.
      expect(after[0]!.className).toContain("bg-surface-hover");
      // THE pin: exactly one new scroll, and its receiver is the row that is
      // active NOW (`ab-beta`), not the row that was active before the
      // keystroke (`ab-alpha`, now gone from the list). Without `filtered` in
      // the deps this slice is EMPTY — the effect never re-runs — so the test
      // is red, not vacuously green.
      expect(scrolled().slice(mark)).toEqual([after[0]]);
      expect(scrollStub.mock.calls[mark]![0]).toEqual({ block: "nearest" });
      expect(scrolled().slice(mark)).not.toContain(before[0]!);
    });
});

// ── The `[image #N]` staging marker ───────────────────────────────────────
//
// Every path that stages an image leaves a marker in the draft, and the marker
// travels to the model as part of the prompt (so a prompt can name a specific
// attachment). `N` counts the attachments of THAT message, never the session —
// the harness pushes the text block first and then the images in send order, so
// "the Nth image of this prompt" is the only reading a model can resolve.
//
// `stageFiles` is the single funnel for all four staging paths (paste-with-file-
// items, the WebKitGTK empty-paste clipboard fallback, drag-and-drop, and the `+`
// picker). The marker surface for those four paths moved to
// `src/hooks/useChatAttachments.test.tsx` with `stageFiles` (issue #135 §1);
// what is under test HERE is the marker's other half — the draft text that
// `send()` puts on the wire, and the `#`-collision mask that protects it.
describe("ChatStream — the [image #N] staging marker", () => {
  // The staging/marker/renumber surface itself (the four staging paths, the
  // caret rule, the batch numbering, the remove-and-renumber) moved to
  // `src/hooks/useChatAttachments.test.tsx` with `stageFiles` and
  // `removeAttachment` (issue #135 §1). What stays here is the half that needs
  // the real `send()`: the renumber → SEND linkage below, and the `#`-collision
  // / mask feed-forward pins after it — both of which expand the draft on the
  // wire, which the hook never does.

  it("the renumbered draft is what gets sent", async () => {
    seedLiveSessionWithImages();
    render(<ChatStream />);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }),
    ]);
    pasteToComposer([
      new File([new Uint8Array([4, 5, 6])], "b.png", { type: "image/png" }),
    ]);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Remove image attachment" })[0]!,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith("s1", "[image #1]", [
        { name: "b.png", mimeType: "image/png", sizeBytes: 3, data: "BAUG" },
      ]),
    );
  });

  // ── The `#` collision (the task's one real risk) ─────────────────────────
  //
  // `MCP_MENTION_RE` is `/(^|\s)#([a-z0-9]+(?:-[a-z0-9]+)*)/g`, so `[image #3]`
  // IS a mention token (`3` is in the class, the `#` has its space). It survives
  // today only because no catalog entry is named `3` — and the Rust picker
  // predicate `is_mentionable_name` ACCEPTS digits (its own tests use `"0"` as
  // a positive case). So a server literally named `3` would make `expandMentions`
  // append an `<mcp name="3">` block to a prompt the user never asked for. The
  // mask in `send()` makes that structurally impossible.

  it("a marker never expands into an <mcp> block even when the catalog has a server of that number",
    async () => {
      seedLiveSessionWithImages();
      seedMcpMentionsOn();
      // THE collision case: a server literally named `3`.
      vi.mocked(listMcpServersEffective).mockResolvedValueOnce([
        { name: "3", kind: "stdio", summary: "a server named with a digit" },
      ]);
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      pasteToComposer(
        ["a", "b", "c"].map(
          (n) =>
            new File([new Uint8Array([1])], `${n}.png`, { type: "image/png" }),
        ),
      );
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
      const sent = vi.mocked(sendPrompt).mock.calls[0]![1] as string;
      // Byte-exact: the markers round-trip through the mask verbatim and NO
      // block is appended.
      expect(sent).toBe("[image #1] [image #2] [image #3]");
      expect(sent).not.toContain("<mcp");
    });

  it("the mask does NOT disable a real # mention sharing the draft with a marker",
    async () => {
      seedLiveSessionWithImages();
      seedMcpMentionsOn();
      // The MCP catalog is seeded LOCALLY, on purpose: a later describe — now in
      // `src/components/ChatStreamDirectoryCompletion.test.tsx`, where that block
      // moved (issue #135 §5) — seeds the MCP catalog with a persistent
      // `mockResolvedValue` (an implementation, which `clearAllMocks` does not
      // undo), so a test that relied on the default `postgres` row would pass
      // when run alone and fail in file order. The summary matches the
      // `postgres` block text asserted below.
      vi.mocked(listMcpServersEffective).mockResolvedValueOnce([
        { name: "postgres", kind: "stdio", summary: "npx -y x-mcp" },
      ]);
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      pasteToComposer([
        new File([new Uint8Array([1])], "s.png", { type: "image/png" }),
      ]);
      // The user types around the marker (a `fireEvent.change` is exactly the
      // keystroke that does — the draft is plain text).
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "query #postgres [image #1]" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
      const sent = vi.mocked(sendPrompt).mock.calls[0]![1] as string;
      expect(sent).toContain('<mcp name="postgres">');
      // And the marker survived the round trip, in place, unharmed.
      expect(sent.startsWith("query #postgres [image #1]")).toBe(true);
    });

  it("markers-only with no colliding catalog is sent BYTE-IDENTICAL", async () => {
    seedLiveSessionWithImages();
    seedMcpMentionsOn(); // the default catalog is `postgres` — no digit name
    render(<ChatStream />);
    await waitForCatalog(listSkills);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(sendPrompt).toHaveBeenCalledWith("s1", "[image #1]", [
        { name: "s.png", mimeType: "image/png", sizeBytes: 3, data: "AQID" },
      ]),
    );
  });

  // ── The mask sentinel is PASTABLE ────────────────────────────────────────
  //
  // `\uE000` is a Private Use Area codepoint: no keyboard produces it, but a
  // PASTE can carry any codepoint, and a log / data dump / mojibake'd file is
  // full of them. So the sentinel is not un-obtainable, and the un-mask is not
  // automatically a bijection. The two tests below are the two ways that
  // bites: an unpaired sentinel must not become the literal word "undefined",
  // and a draft holding both a marker and a stray sentinel must degrade to
  // sending the user's text UNEXPANDED rather than to corrupting it.

  it("a pasted mask sentinel in a marker-free prompt is sent BYTE-UNCHANGED",
    async () => {
      seedLiveSession(); // no attachments, so NO markers can exist to mask
      render(<ChatStream />);
      // A log line that happens to carry a PUA codepoint (the realistic shape:
      // data pasted in from elsewhere, not something the user typed).
      const pasted = "decode this: \uE000 and report";
      fireEvent.change(screen.getByRole("textbox"), { target: { value: pasted } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
      const sent = vi.mocked(sendPrompt).mock.calls[0]![1] as string;
      // Byte-for-byte the user's text. An unbounded un-mask replacer returns
      // `undefined` for an unpaired sentinel and JS stringifies the result, so
      // the model would read "decode this: undefined and report".
      expect(sent).toBe(pasted);
      expect(sent).not.toContain("undefined");
    });

  it("a marker AND a pasted mask sentinel send UNEXPANDED (no block, no rewrite)",
    async () => {
      seedLiveSessionWithImages();
      seedMcpMentionsOn();
      // The catalog entry that makes skipping the expansion worthwhile: a
      // server literally named `3`, so a `#3` token in prose WOULD expand.
      vi.mocked(listMcpServersEffective).mockResolvedValueOnce([
        { name: "3", kind: "stdio", summary: "a server named with a digit" },
      ]);
      render(<ChatStream />);
      await waitForCatalog(listSkills);
      pasteToComposer([
        new File([new Uint8Array([1])], "s.png", { type: "image/png" }),
      ]);
      const draft = `look [image #1] at #3 and \uE000 tail`;
      fireEvent.change(screen.getByRole("textbox"), { target: { value: draft } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
      const sent = vi.mocked(sendPrompt).mock.calls[0]![1] as string;
      // The pathological draft (a marker to mask AND a stray sentinel to
      // restore) sends the user's own text UNEXPANDED: no `<mcp>` block for the
      // `#3` token that pass loses, because corrupting the prompt is worse than
      // one send without mention expansion.
      expect(sent).not.toContain("<mcp");
      expect(sent).toContain("[image #1]");
      // And the pasted sentinel survives as the byte it was, not as "undefined".
      expect(sent).toBe(draft);
    });
});

describe("ChatStream — the failed-send attachment restore", () => {
  /** The composer's current draft text. */
  function composerValue(): string {
    return (screen.getByRole("textbox") as HTMLTextAreaElement).value;
  }

  /** The composer strip's thumbnail file names, LEFT TO RIGHT — i.e. the
   * attachment ORDER the `[image #N]` markers count against. */
  function composerThumbs(): string[] {
    const composer = document.querySelector('[data-testid="composer-island"]')!;
    return Array.from(composer.querySelectorAll("img")).map(
      (el) => el.getAttribute("alt") ?? "",
    );
  }

  const png = (name: string, byte: number): File =>
    new File([new Uint8Array([byte, byte + 1, byte + 2])], name, {
      type: "image/png",
    });

  it("a failed send renumbers the draft when it re-prepends the held attachments",
    async () => {
      // The marker numbers are POSITIONAL (they count THIS message's
      // attachments in list order), and the restore merges the held list IN
      // FRONT of whatever was staged during the turn. So staging A, sending
      // (A leaves the list), then pasting B mid-turn numbers B `#1` — and a
      // restore that puts A back in front without moving the draft's numbers
      // leaves `[image #1]` naming A while the user means B: the next prompt
      // names the wrong picture, which is exactly what the marker contract
      // exists to prevent.
      seedLiveSessionWithImages();
      const inflight = deferred<StopReason>();
      vi.mocked(sendPrompt).mockImplementationOnce(() => inflight.promise);
      render(<ChatStream />);
      pasteToComposer([png("a.png", 1)]);
      expect(composerValue()).toBe("[image #1]");
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      // Wait until the send is genuinely IN FLIGHT: only then has the draft
      // been cleared and A moved to the held map (pasting earlier would edit
      // the draft mid-read, and `send()`'s stale-draft guard would abort the
      // send before `sendPrompt` — a different test entirely).
      await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
      await flush();
      pasteToComposer([png("b.png", 4)]);
      // B is numbered against the list as it stands NOW (empty — A is held),
      // so it is `#1`. This is the premise of the bug, not a bug itself.
      expect(composerValue()).toBe("[image #1]");
      await act(async () => {
        inflight.reject(new Error("boom"));
      });
      await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
      // Both pictures are back, A first (the restore prepends).
      expect(composerThumbs()).toEqual(["a.png", "b.png"]);
      // …so B — still the picture the draft names — is position 2.
      expect(composerValue()).toBe("[image #2]");
      // And the contract end to end: the NEXT send ships the pictures in list
      // order with the marker naming the right one.
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(2));
      expect(sendPrompt).toHaveBeenCalledWith("s1", "[image #2]", [
        { name: "a.png", mimeType: "image/png", sizeBytes: 3, data: "AQID" },
        { name: "b.png", mimeType: "image/png", sizeBytes: 3, data: "BAUG" },
      ]);
    });

  // `"a failed send restores at most MAX_CHAT_ATTACHMENTS and releases the
  // overflow"` moved to `src/hooks/useChatAttachments.test.tsx` with the restore
  // itself (issue #135 §1) — it asserts the cap, the overflow release and the
  // shifted marker, all of which are now the hook's boundary. What stays here is
  // the end-to-end above: its SECOND send needs the real `sendText` +
  // `readAttachmentAsBase64`, which the hook test's relay cannot reproduce.
});

// ── Staging attachments WHILE a turn is in flight ───────────────────────────
//
// Clipboard paste has NEVER checked `composerLocked`: mid-turn it stages. Drag
// -and-drop and the `+` picker both refused, so the three routes disagreed —
// and the queue makes the disagreement a defect: a user who pastes a screenshot
// mid-turn and then queues a text prompt leaves the image stranded in the
// composer while the words travel. Un-gating the two paths makes every route
// stage, which is what makes "attachments queue with the text" TRUE.
//
// `imageCapable` is NOT part of this change: it stays the fail-closed
// CAPABILITY gate on all three paths, and `composerEnabled` stays on the picker
// (a session that cannot be sent to must not accumulate images). Send stays
// disabled — Enter reaches `send()`, which enqueues.
describe("ChatStream — staging attachments is allowed while a turn is in flight", () => {
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

  /** Lock the composer the way a real turn does (`inTurn`, the store's ground
   * truth) — NOT a disabled textarea, which stays editable on purpose. */
  async function lockWithTurn(): Promise<void> {
    await act(async () => {
      useSessions.getState().beginTurn("s1");
    });
  }

  it("a drop STAGES while the composer is locked (the turn is not a capability check)",
    async () => {
      seedLiveSessionWithImages();
      render(<ChatStream />);
      await lockWithTurn();
      // The lock really is engaged — the store's ground truth, and the reason
      // `handleDrop` used to swallow this drop.
      expect(useSessions.getState().inTurn["s1"]).toBe(true);
      expect(
        (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).hasAttribute(
          "disabled",
        ),
      ).toBe(true);
      dropOnComposer([png("d.png", 1)]);
      expect(screen.queryByAltText("d.png")).toBeTruthy();
    });

  it("the `+` picker STAGES while the composer is locked (dialog opens, thumbnail appears)",
    async () => {
      seedLiveSessionWithImages();
      render(<ChatStream />);
      await lockWithTurn();
      vi.mocked(openFilePicker).mockResolvedValueOnce(["/home/u/pics/shot.png"]);
      vi.mocked(readFileBytes).mockResolvedValueOnce([
        0x89, 0x50, 0x4e, 0x47, 1, 2, 3,
      ]);
      fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
      // The dialog opened — the button is NOT disabled mid-turn.
      expect(vi.mocked(openFilePicker)).toHaveBeenCalledTimes(1);
      // And the picked image reached the strip through the SAME `stageFiles`
      // funnel as the paste / drop.
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Remove image attachment" }),
        ).toBeTruthy(),
      );
      expect(screen.getByAltText("shot.png")).toBeTruthy();
      // Send is STILL disabled mid-turn: staging is allowed, dispatching is not.
      expect(
        (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).hasAttribute(
          "disabled",
        ),
      ).toBe(true);
    });

  it("an image dropped mid-turn queues WITH the next prompt instead of stranding",
    async () => {
      seedLiveSessionWithImages();
      render(<ChatStream />);
      await lockWithTurn();
      // Mid-turn staging (the drop, the route this task un-gates).
      dropOnComposer([png("d.png", 1)]);
      expect(composerThumbs()).toEqual(["d.png"]);
      // Plain prose (no marker) — the attachment travels with the entry
      // regardless of whether the draft names it.
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "check the screenshot" },
      });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      // Not dispatched — the lock still holds the wire.
      expect(sendPrompt).not.toHaveBeenCalled();
      const entry = queue()[0];
      expect(entry).toBeTruthy();
      expect(entry!.text).toBe("check the screenshot");
      // THE POINT OF THE TASK: the image went with the words.
      expect(entry!.attachments.map((a) => a.filename)).toEqual(["d.png"]);
      expect(entry!.attachments[0]!.objectUrl).toBe("blob:mock-d.png");
      // The object URL MOVED (never revoked-and-recreated — revoking here would
      // kill both the queue row's preview and the later send's file).
      expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:mock-d.png");
      // The composer's strip is EMPTY — nothing stranded behind.
      expect(composerThumbs()).toEqual([]);
      expect(
        (screen.getByRole("textbox") as HTMLTextAreaElement).value,
      ).toBe("");
    });

  it("`!imageCapable` still blocks the drop and the `+` picker mid-turn (fail-closed)",
    async () => {
      seedLiveSession(); // capabilities: {} — NOT image-capable
      render(<ChatStream />);
      await lockWithTurn();
      dropOnComposer([png("d.png", 1)]);
      expect(screen.queryByAltText("d.png")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
      await flush();
      // The capability gate — not the turn — is what refuses: the dialog never
      // opened and nothing was staged.
      expect(vi.mocked(openFilePicker)).not.toHaveBeenCalled();
      expect(composerThumbs()).toEqual([]);
    });
});

// ── The empty-state film and the prompt queue, in the same pane ──────────────
//
// The film was written before the queue existed. `EmptyStateFilm`'s layer is an
// `absolute inset-0` box on the transcript's scroll container, and the queue
// stack sits BELOW that container as a sibling island — so the two are meant to
// be independent. That independence is exactly the kind of thing a merge
// silently breaks (moving the stack inside `<main>`, or keying the film on
// something the queue changes, would both collide), so it is pinned here rather
// than left to reading the layout.
describe("ChatStream — the empty-state film beside a non-empty prompt queue", () => {
  it("keeps the empty-state cue and the queue rows both rendered and separate", () => {
    seedLiveSession();
    render(<ChatStream />);
    // A `failed` entry is the state where BOTH are legitimately on screen: the
    // session is IDLE (so the film's three-term condition holds and the
    // transcript is still empty), yet `takeHead` skips the failed entry, so
    // nothing sends and the row stays visible. An ordinary queued entry cannot
    // probe this — the idle edge Flushes it, which adds a user row and takes the
    // transcript out of the empty branch.
    act(() => {
      useQueuedPrompts.getState().enqueue("s1", {
        id: "q-film",
        text: "queued while the film plays",
        attachments: [],
        state: "queued",
      });
    });
    act(() => {
      const [entry] = useQueuedPrompts.getState().bySession["s1"];
      useQueuedPrompts.getState().requeueHead("s1", { ...entry, failed: true });
    });
    const cue = screen.getByText("Send a prompt to start");
    const rows = screen.getByTestId("queue-rows");
    expect(rows.textContent).toContain("queued while the film plays");
    // STRUCTURAL separation: the film belongs to the transcript island, the
    // stack is outside it. If the stack ever moves inside `<main>`, the film's
    // `absolute inset-0` layer would cover it.
    const main = document.querySelector("main")!;
    expect(main.contains(cue)).toBe(true);
    expect(main.contains(rows)).toBe(false);
    expect(main.nextElementSibling).toBe(rows);
    // The film's own layer is bounded by the transcript island: the scroll
    // container it renders into is `relative`, so the canvas variant's
    // `absolute inset-0` (pinned in `EmptyStateFilm.test.tsx`) resolves against
    // THAT box — inside `<main>` — and can never overlay a row in the stack.
    // Under jsdom there is no WebGL, so what is on screen here is the film's
    // FALLBACK text line; its parent is the scroll container itself.
    const scroll = screen.getByTestId("transcript-scroll");
    expect(scroll.className).toContain("relative");
    expect(main.contains(scroll)).toBe(true);
    expect(scroll.contains(cue)).toBe(true);
    expect(scroll.contains(rows)).toBe(false);
    expect(cue.closest('[data-testid="queue-rows"]')).toBeNull();
  });

  it("does not render the film while a turn is in flight (the queue's own state)", () => {
    seedLiveSession();
    render(<ChatStream />);
    act(() => {
      useSessions.getState().beginTurn("s1");
    });
    act(() => {
      useQueuedPrompts.getState().enqueue("s1", {
        id: "q-film-busy",
        text: "queued",
        attachments: [],
        state: "queued",
      });
    });
    // The three-term empty-branch condition is UNCHANGED by the film work, and
    // a busy session fails it — so no film, and no fight with the queue.
    expect(screen.queryByText("Send a prompt to start")).toBeNull();
    expect(screen.getByTestId("queue-rows")).toBeTruthy();
  });
});
