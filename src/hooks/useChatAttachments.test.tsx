import { beforeEach, describe, expect, it, vi, beforeAll } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState, type RefObject } from "react";
import {
  seedLiveSession,
  seedLiveSessionWithImages,
  pasteToComposer,
  dropOnComposer,
  flush,
  deferred,
} from "../test/chatStreamFixtures";
import { MAX_CHAT_ATTACHMENTS } from "../lib/chatAttachments";
import {
  readClipboardImage,
  readFileBytes,
  sendPrompt,
  type StopReason,
} from "../lib/tauri";
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import { useSessions } from "../store/sessions";
import { useQueuedPrompts } from "../store/queuedPrompts";
import { setSidePaneCollapsed } from "../lib/sidePaneState";
import { clearSkillCatalogCache } from "../hooks/useSkillCatalog";
import { clearMentionCatalogsCache } from "../hooks/useMentionCatalogs";
import { resetStores } from "../test/resetStores";
import {
  useChatAttachments,
  type UseChatAttachmentsResult,
} from "./useChatAttachments";

/**
 * `useChatAttachments` — the composer's attachment lifecycle (issue #135 §1).
 *
 * These 34 tests were MOVED VERBATIM out of `src/components/ChatStream.test.tsx`
 * alongside the five handlers, the `attachments` cell and the held-for-send map
 * they drive. `it` titles and assertion bodies are unchanged; the only edits are
 * the harness substitutions (`render(<ChatStream />)` → `render(<Harness … />)`)
 * and, for the four failed-send tests, driving the hook's boundary through
 * `sendRelay` instead of the real `send` — which wave 3 (`C1`) replaces.
 *
 * This file is `.tsx` because the hook's contract IS DOM: the staged strip, the
 * caret the markers land at, the `img` a revoked object URL can no longer render
 * (the same reason `useDragReorder.test.tsx` and `ChatStream.test.tsx` are
 * `.tsx`).
 *
 * WHAT STAYED in `ChatStream.test.tsx` on purpose — the things only the real
 * component can prove: the capability PROVENANCE pin (`"paste stages a thumbnail
 * in a resumable stored session"` — the hook receives a value, it cannot be
 * shown to derive one), the `+`-button enablement trio and the picker hand-off
 * (`ComposerRow` wiring), the window drop backstop (a separate hook), the
 * session-switch effect (`prevSessionIdRef` + `clearAll`/`releaseHeldForSend`
 * wiring — there is no effect to run here), every full-send test (`sendText`,
 * `readAttachmentAsBase64`, the `#`-collision mask), and the queue / Flush /
 * staging-while-in-flight integration.
 *
 * WHY the `vi.mock` factories are INLINE here and not delegated to
 * `src/test/chatStreamFixtures.ts`: that module imports `useSessions` /
 * `useSettings`, whose stores import `../lib/tauri`, so it HAS a transitive path
 * into the mocked barrel, and a factory body may reference only bindings from a
 * module free of that path — a delegation fails as 0 tests run with
 * `Cannot access '__vi_import_N__' before initialization` (measured; the probe
 * matrix in `docs/roadmap/chatstream-decomposition-ground-chat-test-scaffolding.md`).
 * Both factories below therefore touch nothing but `vi` and their own
 * `vi.importActual` result.
 */

// The environment stubs `src/test/setup.tsx` does NOT provide (moved verbatim
// with the tests that need them).
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

// ── The harness ─────────────────────────────────────────────────────────────
//
// A host component that reproduces EXACTLY the state and refs the five moved
// handlers closed over in `ChatStream`, so the moved test bodies run unchanged.
// The hook owns the `attachments` cell, the `attachmentsRef` mirror and the
// held-for-send map; the harness owns the draft, its live ref and the error line
// — the same split, because `ChatStream` keeps those three (`useMentionPicker`'s
// "the hook never owns the draft" is the precedent).

function Harness(props: { imageCapable?: boolean; composerEnabled?: boolean }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // Subscribed the way `ChatStream` subscribes (a selector, NOT `getState()`):
  // the paste-fallback session guard reads the LIVE active session at paste
  // time, and the component only sees a switch because it RE-RENDERS on it — a
  // `getState()` read here would leave the ref stale and the straddle test would
  // pass for the wrong reason.
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  // Mirror ChatStream's re-sync: the paste-fallback session guard reads the LIVE
  // active session at paste time, exactly as `activeSessionIdRef.current =
  // activeSessionId` does in the component.
  activeSessionIdRef.current = activeSessionId;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const api = useChatAttachments({
    setDraft,
    setError,
    draftRef,
    activeSessionIdRef,
    composerRef,
    imageCapable: props.imageCapable ?? true,
    composerEnabled: props.composerEnabled ?? true,
  });
  // The handles `sendRelay` mirrors `send`'s closures over: the harness's OWN
  // draft/setDraft/setError (the hook owns none of them — exactly as
  // `ChatStream` keeps them).
  const relayDeps = { draftRef, setDraft, setError };
  return (
    <div data-testid="composer-island">
      <textarea
        ref={composerRef}
        value={draft}
        placeholder="Ask for follow-up changes"
        onChange={(e) => setDraft(e.target.value)}
        onPaste={api.handlePaste}
        onDrop={api.handleDrop}
      />
      <button onClick={() => void api.handleAttachClick()}>Attach files</button>
      <button onClick={() => sendRelay(api, relayDeps)}>Send</button>
      {api.attachments.map((a, i) => (
        <div key={a.id}>
          <img alt={a.filename} src={a.objectUrl} />
          {/* the strip's badge: the marker number (1-based) the thumbnail carries */}
          <span aria-hidden="true">#{i + 1}</span>
          <button onClick={() => api.removeAttachment(a.id)}>
            Remove image attachment
          </button>
        </div>
      ))}
      {/* the composer's error line — `IpcErrorLine`'s role/class, reproduced so
          the staging rejection tests that assert them can move with the hook */}
      {error && (
        <div role="alert" className="text-ui-sm text-destructive mb-2 px-3">
          {error}
        </div>
      )}
    </div>
  );
}

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

// Minimal `send()` call-alike, pre-wave-3: drives the hook's boundary functions
// in `send`'s real order — (1) wipe the draft `setDraft("")` (the ARRIVES FIRST,
// exactly as `onCommitted`'s first statement at `ChatStream.tsx` — the
// failed-send tests' premise "the text typed before Send is lost" depends on
// it), (2) move the whole staged set out of the composer (`moveOutForSend`,
// `onCommitted`'s held move), (3) await the (mocked) IPC, and on rejection (4)
// restore through `restoreHeldForSend`, which shifts the draft's markers by the
// number ACTUALLY restored and lands the error line in the same synchronous
// block (the React 19 batching contract). A relay that SKIPS step 1 makes the
// moved tests pass for the wrong reason (the draft would still hold the typed
// text) — the wipe is part of the contract under test.
function sendRelay(
  api: UseChatAttachmentsResult,
  deps: {
    draftRef: RefObject<string>;
    setDraft: (value: string) => void;
    setError: (value: string | null) => void;
  },
): void {
  const sessionId = "s1";
  // 1. `onCommitted`'s FIRST statement: wipe the draft.
  deps.setDraft("");
  // 2. the held move — the whole staged set leaves `attachments` (held, not
  //    released; `moveOutForSend` reads `api.attachmentsRef.current` itself).
  const staged = api.attachmentsRef.current;
  api.moveOutForSend(sessionId, new Set(staged.map((a) => a.id)));
  // 3. the awaited IPC — the draft is read LIVE via the harness's `draftRef`
  //    (the same handle the real `send` uses), NOT from `api.attachmentsRef`
  //    (that is the attachment list, and it was just emptied by the move — a
  //    typo would send "" as the prompt text).
  void sendPrompt(sessionId, deps.draftRef.current, undefined).catch(
    (err: unknown) => {
      // 4. the catch: restore held → shift markers → land the error line in the
      //    same synchronous block. `setError`/`setDraft` are the harness's own
      //    setters.
      api.restoreHeldForSend(
        sessionId,
        err instanceof Error ? err.message : String(err),
        deps.setError,
        deps.setDraft,
      );
    },
  );
}

describe("useChatAttachments — paste / drop / staging / remove", () => {
  it("returns exactly the fields ChatStream threads into ComposerRow PLUS the held boundary and the two clears, and no more", () => {
    // The house surface pin (`useMentionPicker`'s "returns exactly the six
    // fields … and no more"): the sorted key list IS the contract wave 3 codes
    // against, so a name added or dropped reddens here rather than in a
    // dispatch refactor. The minimum args below are an implementation detail —
    // a stub host wrapper would do as well.
    const { result } = renderHookLike();
    expect(Object.keys(result).sort()).toEqual([
      "attachments",
      "attachmentsRef",
      "stageFiles",
      "handlePaste",
      "handleDrop",
      "handleAttachClick",
      "removeAttachment",
      "moveOutForSend",
      "restoreHeldForSend",
      "releaseHeldForSend",
      "clearAll",
      "clearStaged",
    ].sort());
  });

  // --- Image attachments: paste / drop / thumbnail strip / capability gate. ---

  it("paste stages a thumbnail", () => {
    seedLiveSessionWithImages();
    render(<Harness />);
    const intercepted = pasteToComposer([
      new File([new Uint8Array([1])], "s.png", { type: "image/png" }),
    ]);
    // The paste WAS intercepted (`preventDefault` → `defaultPrevented`).
    expect(intercepted).toBe(false);
    expect(screen.getByAltText("s.png")).toBeTruthy();
  });

  it("paste of plain text is NOT intercepted", () => {
    seedLiveSessionWithImages();
    render(<Harness />);
    const intercepted = pasteToComposer([], { text: "hello" });
    // Default text paste falls through (jsdom does not implement the browser's
    // default paste action — no text is inserted; assert on the return value).
    expect(intercepted).toBe(true);
    expect(screen.queryByAltText("s.png")).toBeNull();
  });

  it("paste of plain text does NOT trigger the Rust clipboard read", async () => {
    seedLiveSessionWithImages();
    render(<Harness />);
    pasteToComposer([], { text: "hello" });
    await flush();
    // A text paste is a text paste — no image read (no stale image staged).
    expect(vi.mocked(readClipboardImage)).not.toHaveBeenCalled();
    expect(screen.queryByAltText("s.png")).toBeNull();
  });

  it("paste with file items does NOT trigger the Rust clipboard read", async () => {
    seedLiveSessionWithImages();
    render(<Harness />);
    pasteToComposer([
      new File([new Uint8Array([1])], "s.png", { type: "image/png" }),
    ]);
    await flush();
    // The standard `items` path handles it — no fallback read.
    expect(vi.mocked(readClipboardImage)).not.toHaveBeenCalled();
    expect(screen.getByAltText("s.png")).toBeTruthy();
  });

  it("WebKitGTK quirk: empty paste event falls back to the Rust clipboard read", async () => {
    seedLiveSessionWithImages();
    render(<Harness />);
    // WebKitGTK: a pasted image produces a `paste` event with NO items and
    // NO text (the DataTransfer is empty). The composer reads the image
    // from the system clipboard (Rust/arboard) instead.
    vi.mocked(readClipboardImage).mockResolvedValueOnce([0x89, 0x50, 0x4e, 0x47]);
    pasteToComposer([]);
    await flush();
    expect(vi.mocked(readClipboardImage)).toHaveBeenCalledTimes(1);
    // The read image is staged as a thumbnail (`screenshot.png`).
    expect(screen.getByAltText("screenshot.png")).toBeTruthy();
  });

  it("WebKitGTK quirk fallback: no image on the clipboard stages nothing", async () => {
    seedLiveSessionWithImages();
    render(<Harness />);
    vi.mocked(readClipboardImage).mockResolvedValueOnce(null);
    pasteToComposer([]);
    await flush();
    expect(vi.mocked(readClipboardImage)).toHaveBeenCalledTimes(1);
    expect(screen.queryByAltText("screenshot.png")).toBeNull();
  });

  it("WebKitGTK quirk fallback: a read error stages nothing (silent)", async () => {
    seedLiveSessionWithImages();
    render(<Harness />);
    vi.mocked(readClipboardImage).mockRejectedValueOnce(new Error("no display"));
    pasteToComposer([]);
    await flush();
    expect(screen.queryByAltText("screenshot.png")).toBeNull();
    // No error line for a silent fallback miss (an empty-clipboard paste is
    // not an error condition).
    expect(screen.queryByText(/clipboard/i)).toBeNull();
  });

  it("spreadsheet TSV is NOT intercepted over the synthetic PNG", () => {
    seedLiveSessionWithImages();
    render(<Harness />);
    const intercepted = pasteToComposer(
      [new File([new Uint8Array([1])], "shot.png", { type: "image/png" })],
      { text: "a\tb" },
    );
    // The text paste wins (the spreadsheet heuristic) — no thumbnail.
    expect(intercepted).toBe(true);
    expect(screen.queryByAltText("shot.png")).toBeNull();
  });

  it("non-image paste is rejected with an error line", () => {
    seedLiveSessionWithImages();
    render(<Harness />);
    pasteToComposer(
      [new File([new Uint8Array([1])], "a.txt", { type: "text/plain" })],
      { text: "x" },
    );
    expect(screen.queryByAltText("a.txt")).toBeNull();
    const errorLine = screen.getByText(/is not a supported image format/);
    expect(errorLine.className).toContain("text-destructive");
    // Task C3 (finding 7): the composer's rejection line is now an announced
    // live region. Asserted HERE (the site's existing error-line test) rather
    // than in a new case, so the class pin and the role pin travel together.
    expect(errorLine.getAttribute("role")).toBe("alert");
    // Byte-identical to the hand-written `mb-2 px-3 text-ui-sm text-destructive`
    // line this replaced, so the gap under the transcript does not move.
    expect(errorLine.getAttribute("class")).toBe(
      "text-ui-sm text-destructive mb-2 px-3",
    );
  });

  it("SVG is rejected (allowlist)", () => {
    seedLiveSessionWithImages();
    render(<Harness />);
    pasteToComposer([
      new File([new Uint8Array([1])], "a.svg", { type: "image/svg+xml" }),
    ]);
    expect(screen.queryByAltText("a.svg")).toBeNull();
    expect(
      screen.getByText(/is not a supported image format/).className,
    ).toContain("text-destructive");
  });

  it("oversized paste is rejected", () => {
    seedLiveSessionWithImages();
    render(<Harness />);
    // 11 MiB > the 10 MiB inline cap.
    const oversized = new File(
      [new Uint8Array(11 * 1024 * 1024)],
      "big.png",
      { type: "image/png" },
    );
    pasteToComposer([oversized]);
    expect(screen.queryByAltText("big.png")).toBeNull();
    expect(
      screen.getByText(/exceeds the 10 MiB limit/).className,
    ).toContain("text-destructive");
  });

  it("ninth image is rejected at the cap", () => {
    seedLiveSessionWithImages();
    render(<Harness />);
    const firstEight = Array.from({ length: 8 }, (_, i) =>
      new File([new Uint8Array([1])], `f${i}.png`, { type: "image/png" }),
    );
    pasteToComposer(firstEight);
    // Separate dispatch — the ref-based `stageFiles` keeps the list current
    // between them.
    pasteToComposer(
      [new File([new Uint8Array([1])], "ninth.png", { type: "image/png" })],
    );
    // 8 staged, the 9th rejected.
    expect(screen.getAllByRole("img")).toHaveLength(8);
    expect(screen.queryByAltText("ninth.png")).toBeNull();
    expect(
      screen.getByText(/at most 8/).className,
    ).toContain("text-destructive");
  });

  it("remove button un-stages", () => {
    seedLiveSessionWithImages();
    render(<Harness />);
    pasteToComposer([
      new File([new Uint8Array([1])], "s.png", { type: "image/png" }),
    ]);
    expect(screen.getByAltText("s.png")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove image attachment" }),
    );
    expect(screen.queryByAltText("s.png")).toBeNull();
  });

  it("drop stages a thumbnail", () => {
    seedLiveSessionWithImages();
    render(<Harness />);
    dropOnComposer([
      new File([new Uint8Array([1])], "d.png", { type: "image/png" }),
    ]);
    expect(screen.getByAltText("d.png")).toBeTruthy();
  });

  it("drop STAGES while locked", () => {
    seedLiveSessionWithImages();
    // `inTurn` set BEFORE `render` (the store is global) → the composer is
    // locked on first render. Staging is still allowed: the textarea stays
    // editable on purpose and the drop reaches `stageFiles`.
    useSessions.setState({ inTurn: { s1: true } });
    render(<Harness />);
    dropOnComposer([
      new File([new Uint8Array([1])], "d.png", { type: "image/png" }),
    ]);
    expect(screen.queryByAltText("d.png")).not.toBeNull();
  });

  it("unmount releases staged object URLs", () => {
    seedLiveSessionWithImages();
    const { unmount } = render(<Harness />);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    expect(screen.getByAltText("s.png")).toBeTruthy();
    // The unmount-cleanup effect revokes the staged object URLs exactly once
    // (a revoked URL can no longer render the `img` — the effect runs on
    // unmount ONLY, never on state changes).
    unmount();
    // The `beforeAll` stub: `createObjectURL(file) => \`blob:mock-${file.name}\``.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-s.png");
  });

  it("feature is inert without the capability", () => {
    seedLiveSession(); // capabilities {}
    render(<Harness imageCapable={false} />);
    const intercepted = pasteToComposer([
      new File([new Uint8Array([1])], "s.png", { type: "image/png" }),
    ]);
    // NOT intercepted (default text paste falls through) and no thumbnail.
    expect(intercepted).toBe(true);
    expect(screen.queryByAltText("s.png")).toBeNull();
    // The single placeholder (the paste hint if/else is gone).
    expect(screen.getByPlaceholderText("Ask for follow-up changes")).toBeTruthy();
  });
});

describe("useChatAttachments — the held-for-send boundary (via the send relay)", () => {
  it("a failed send keeps attachments staged", async () => {
    seedLiveSessionWithImages();
    const { container } = render(<Harness />);
    vi.mocked(sendPrompt).mockRejectedValueOnce(new Error("boom"));
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // Wait on the OUTCOME (the error line) — NOT on the Send button being
    // enabled: with a staged attachment it is enabled before the click and
    // stays enabled right after (the composer isn't locked until `beginTurn`,
    // which runs only after the FileReader `await`), so a button-state wait
    // would pass immediately and make the test flaky.
    await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
    // The attachment was NOT released/cleared (a failed send keeps it) —
    // the composer thumbnail is still present.
    const composer = container.querySelector('[data-testid="composer-island"]')!;
    const matches = screen.getAllByAltText("s.png");
    expect(matches.some((el) => composer.contains(el))).toBe(true);
  });

  it("a failed send restores the thumbnail WITHOUT releasing its object URL", async () => {
    seedLiveSessionWithImages();
    const { container } = render(<Harness />);
    vi.mocked(sendPrompt).mockRejectedValueOnce(new Error("boom"));
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
    // The restored thumbnail is the SAME object URL, still live.
    const composer = container.querySelector('[data-testid="composer-island"]')!;
    const inComposer = screen
      .getAllByAltText("s.png")
      .filter((el) => composer.contains(el));
    expect(inComposer).toHaveLength(1);
    expect(inComposer[0]!.getAttribute("src")).toBe("blob:mock-s.png");
    // And it was NOT revoked — a revoked URL can no longer render an `img`, so
    // releasing before the restore would have given a broken thumbnail. The
    // release belongs to the session-switch / unmount / next-successful-send
    // paths, never to the failure path.
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:mock-s.png");
  });

  it("unmounting while a send is in flight releases the held attachment", async () => {
    seedLiveSessionWithImages();
    const { unmount } = render(<Harness />);
    const inflight = deferred<StopReason>();
    vi.mocked(sendPrompt).mockImplementationOnce(() => inflight.promise);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "look at this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // The send is in flight and the attachment has LEFT the composer state —
    // it lives only in the held-for-send map now, so the unmount cleanup has
    // to walk that map too or the object URL leaks for the process lifetime.
    await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-s.png");
    // Unwind the pending IPC so no promise outlives the test.
    await act(async () => {
      inflight.resolve("end_turn");
    });
  });

  it("a paste-fallback clipboard read that straddles a session switch stages nothing (session guard)", async () => {
    seedLiveSessionWithImages();
    // A second image-capable session to switch TO (its composer would
    // stage the image without the guard).
    useSessions.setState({
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
          capabilities: { promptCapabilities: { image: true } },
          archived: false,
        },
      ],
    });
    render(<Harness />);
    // Deferred promise: the clipboard read is SLOW (in flight across the
    // session switch — the race the guard exists for).
    let resolveRead: (value: number[] | null) => void = () => {};
    vi.mocked(readClipboardImage).mockImplementationOnce(
      () => new Promise<number[] | null>((r) => (resolveRead = r)),
    );
    // WebKitGTK quirk path: an empty paste event (no files, no text).
    pasteToComposer([]);
    expect(vi.mocked(readClipboardImage)).toHaveBeenCalledTimes(1);
    // Switch the active session WHILE the read is in flight.
    await act(async () => {
      useSessions.setState({ activeSessionId: "s2" });
    });
    // The session-change effect cleared s1's staged attachments (sanity).
    expect(screen.queryByAltText("screenshot.png")).toBeNull();
    // Settle the read: the image was captured for s1 — it must NOT be
    // staged into the NEW active session (s2).
    await act(async () => {
      resolveRead([0x89, 0x50, 0x4e, 0x47]);
      await Promise.resolve();
    });
    expect(screen.queryByAltText("screenshot.png")).toBeNull();
  });
});

describe("useChatAttachments — the [image #N] staging marker", () => {
  it("a pasted screenshot leaves [image #1] in the draft", () => {
    seedLiveSessionWithImages();
    render(<Harness />);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }),
    ]);
    expect(composerValue()).toBe("[image #1]");
  });

  it("a second paste is #2 — the number counts THIS message's attachments in staging order",
    () => {
      seedLiveSessionWithImages();
      render(<Harness />);
      const one = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
      pasteToComposer([one]);
      pasteToComposer([
        new File([new Uint8Array([2])], "b.png", { type: "image/png" }),
      ]);
      expect(composerValue()).toBe("[image #1] [image #2]");
    });

  it("a batch of three staged in ONE event numbers ascending #1 #2 #3", () => {
    // Inserting one marker at a time at the same caret would emit `#3 #2 #1`
    // and invert the marker→image mapping on every multi-file paste.
    seedLiveSessionWithImages();
    render(<Harness />);
    pasteToComposer(
      ["a", "b", "c"].map(
        (n) => new File([new Uint8Array([1])], `${n}.png`, { type: "image/png" }),
      ),
    );
    expect(composerValue()).toBe("[image #1] [image #2] [image #3]");
    expect(screen.getAllByRole("img")).toHaveLength(3);
  });

  it("a rejected file in a mixed batch inserts NO marker (the count comes from the staged list)",
    () => {
      // `addImageAttachments` can reject mid-batch, so the marker count must be
      // derived from the returned list — looping the INPUT would number the
      // survivor `#2` and the number would name the wrong picture.
      seedLiveSessionWithImages();
      render(<Harness />);
      pasteToComposer([
        new File([new Uint8Array([1])], "ok.png", { type: "image/png" }),
        new File([new Uint8Array([1])], "bad.txt", { type: "text/plain" }),
      ]);
      expect(composerValue()).toBe("[image #1]");
      expect(screen.getAllByAltText("ok.png")).toHaveLength(1);
    });

  it("a fully rejected batch inserts nothing at all", () => {
    seedLiveSessionWithImages();
    render(<Harness />);
    pasteToComposer([
      new File([new Uint8Array([1])], "a.svg", { type: "image/svg+xml" }),
    ]);
    expect(composerValue()).toBe("");
  });

  it("the drop path inserts a marker too", () => {
    seedLiveSessionWithImages();
    render(<Harness />);
    dropOnComposer([
      new File([new Uint8Array([1])], "d.png", { type: "image/png" }),
    ]);
    expect(composerValue()).toBe("[image #1]");
  });

  it("the `+` file-picker path inserts a marker too", async () => {
    seedLiveSessionWithImages();
    vi.mocked(openFilePicker).mockResolvedValueOnce(["/home/u/pics/shot.png"]);
    vi.mocked(readFileBytes).mockResolvedValueOnce([
      0x89, 0x50, 0x4e, 0x47, 1, 2, 3,
    ]);
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    await waitFor(() => expect(vi.mocked(readFileBytes)).toHaveBeenCalled());
    expect(composerValue()).toBe("[image #1]");
  });

  it("the WebKitGTK empty-paste clipboard fallback inserts a marker too", async () => {
    seedLiveSessionWithImages();
    vi.mocked(readClipboardImage).mockResolvedValueOnce([
      0x89, 0x50, 0x4e, 0x47,
    ]);
    render(<Harness />);
    pasteToComposer([]); // no items, no text — the WebKitGTK shape
    await flush();
    expect(composerValue()).toBe("[image #1]");
  });

  it("a drop onto an UNFOCUSED composer with a non-empty draft appends the marker at the END",
    () => {
      // `selectionStart` is 0 for a textarea that has never been focused, and
      // two of the four staging paths (drag-and-drop, and the `+` picker — the
      // native dialog holds focus) routinely run that way. Reading the caret
      // unconditionally would drop every marker at the START of the user's
      // sentence.
      seedLiveSessionWithImages();
      render(<Harness />);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "explain this" },
      });
      expect(document.activeElement).not.toBe(screen.getByRole("textbox"));
      dropOnComposer([
        new File([new Uint8Array([1])], "d.png", { type: "image/png" }),
      ]);
      expect(composerValue()).toBe("explain this [image #1]");
    });

  it("a paste while the composer is focused lands at the CARET, not at the end",
    () => {
      seedLiveSessionWithImages();
      render(<Harness />);
      const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "explain this" } });
      textarea.focus();
      textarea.setSelectionRange(7, 7); // after "explain", before " this"
      pasteToComposer([
        new File([new Uint8Array([1])], "s.png", { type: "image/png" }),
      ]);
      expect(composerValue()).toBe("explain [image #1] this");
    });

  it("removing an attachment drops its marker and renumbers the survivors", () => {
    seedLiveSessionWithImages();
    render(<Harness />);
    pasteToComposer([
      new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }),
    ]);
    pasteToComposer([
      new File([new Uint8Array([4, 5, 6])], "b.png", { type: "image/png" }),
    ]);
    expect(composerValue()).toBe("[image #1] [image #2]");
    // ✕ on the FIRST thumbnail: `[image #1]` goes and `#2` shifts down, so the
    // remaining number still names the remaining picture.
    fireEvent.click(
      screen.getAllByRole("button", { name: "Remove image attachment" })[0]!,
    );
    expect(composerValue()).toBe("[image #1]");
  });

  it("the strip badges each thumbnail with the number its marker uses", () => {
    seedLiveSessionWithImages();
    render(<Harness />);
    pasteToComposer([
      new File([new Uint8Array([1])], "a.png", { type: "image/png" }),
      new File([new Uint8Array([2])], "b.png", { type: "image/png" }),
    ]);
    // The number in the text has to be checkable against the picture it names.
    expect(screen.getByText("#1").textContent).toBe("#1");
    expect(screen.getByText("#2").textContent).toBe("#2");
    // Non-interactive chrome: it is decoration beside the thumbnail, so it must
    // not leak into the strip's accessible names.
    expect(screen.getByText("#1").getAttribute("aria-hidden")).toBe("true");
  });
});

describe("useChatAttachments — the failed-send attachment restore", () => {
  it("a failed send restores at most MAX_CHAT_ATTACHMENTS and releases the overflow",
    async () => {
      // The cap lives inside `addImageAttachments` (staging time), so the
      // restore path — which writes `attachments` directly — can rebuild a
      // list the cap would never have allowed: send 8, paste a 9th during the
      // turn, fail, and the composer holds 9. The next send would then be
      // rejected server-side for a state the UI itself built.
      seedLiveSessionWithImages();
      const inflight = deferred<StopReason>();
      vi.mocked(sendPrompt).mockImplementationOnce(() => inflight.promise);
      render(<Harness />);
      // 8 staged in ONE batch (the cap: 8 is allowed, a 9th would not be).
      pasteToComposer(
        Array.from({ length: MAX_CHAT_ATTACHMENTS }, (_, i) =>
          png(`h${i + 1}.png`, i + 1),
        ),
      );
      expect(composerThumbs()).toHaveLength(MAX_CHAT_ATTACHMENTS);
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(sendPrompt).toHaveBeenCalled());
      await flush();
      // The 9th, staged while the turn runs (the live list is empty — all 8
      // are held), so its marker is `#1`.
      pasteToComposer([png("late.png", 90)]);
      expect(composerValue()).toBe("[image #1]");
      await act(async () => {
        inflight.reject(new Error("boom"));
      });
      await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
      // The list ends up AT the cap, not above it: the held block keeps only
      // the room the live list leaves, so the LAST held item is the overflow —
      // and the drop mirrors `addImageAttachments`'s silent cap rejection at
      // staging time (the same limit, the same non-error treatment).
      expect(composerThumbs()).toHaveLength(MAX_CHAT_ATTACHMENTS);
      // The strip's badges stop at the cap too (each thumbnail carries `#N`, so
      // a `#9` badge would mean the strip still renders the overflow).
      expect(
        document
          .querySelector('[data-testid="composer-island"]')!
          .querySelectorAll("img"),
      ).toHaveLength(MAX_CHAT_ATTACHMENTS);
      expect(composerThumbs()).toContain("late.png");
      // The overflow is RELEASED, not silently dropped — a dropped-but-live
      // object URL is a leak no path can reach again.
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-h8.png");
      // The draft's number still names the surviving picture: `late.png` is
      // position 8 of the restored list.
      expect(composerValue()).toBe("[image #8]");
    });
});

/** The surface pin's host: the hook called with the MINIMUM args (the wrapper is
 * an implementation detail — the sorted key list is the pin). */
function renderHookLike(): { result: UseChatAttachmentsResult } {
  let captured!: UseChatAttachmentsResult;
  function Probe() {
    const draftRef = useRef("");
    const activeSessionIdRef = useRef<string | null>("s1");
    const composerRef = useRef<HTMLTextAreaElement | null>(null);
    captured = useChatAttachments({
      setDraft: () => {},
      setError: () => {},
      draftRef,
      activeSessionIdRef,
      composerRef,
      imageCapable: true,
      composerEnabled: true,
    });
    return null;
  }
  render(<Probe />);
  return { result: captured };
}
