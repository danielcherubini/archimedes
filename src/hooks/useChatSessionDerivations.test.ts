import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useChatSessionDerivations } from "./useChatSessionDerivations";
import { useSessions } from "../store/sessions";
import { useInteractive, type InteractiveRequestData } from "../store/interactive";
import { resetStores } from "../test/resetStores";
import { makeMessage, makeSessionRow, makeSpaceRow } from "../test/fixtures";

/**
 * The thin adapter over `lib/chatSessionDerivations` (issue #135 §3), driven
 * through the REAL zustand singletons.
 *
 * NO `vi.mock` of any kind — the same posture the closest house-style precedents
 * take (`useChildGates.test.ts` / `useSessionStatus.test.ts` mock nothing). The
 * hook reaches no runtime `lib/tauri` value: `sessionLookup.ts` imports only the
 * barrel's TYPES (erased at runtime), `chatAttachments.ts` imports only
 * `chatAttachmentMetadata`, and no store ACTION is ever called, so no IPC path
 * is exercised. That is what keeps `src/lib/tauriBarrel.test.ts`'s mock-seam pin
 * unmoved by this file.
 *
 * The seeding is deliberately self-contained (NOT the sibling task's
 * `src/test/chatStreamFixtures.ts` — that file is outside this task's owned set).
 */

const ask = (
  requestId: string,
  over: Partial<InteractiveRequestData> = {},
): InteractiveRequestData => ({
  requestId,
  method: "ask",
  source: "main",
  params: {},
  ...over,
});

const confirm = (requestId: string): InteractiveRequestData => ({
  requestId,
  method: "confirm",
  source: "main",
  params: {},
});

const password = (requestId: string): InteractiveRequestData => ({
  requestId,
  method: "password",
  source: "main",
  params: {},
});

/** A LIVE session with the given row capabilities. */
const seedLive = (capabilities: Record<string, unknown> = {}) => {
  useSessions.setState({
    activeSessionId: "s1",
    sessions: [makeSessionRow({ sessionId: "s1", capabilities })],
    messages: { s1: [] },
  });
};

/** A STORED (history-only) session — `sessions` stays `[]` (the reset's initial
 * state), so the three-list walk resolves the row from `historySessions`. */
const seedHistoryOnly = (capabilities: Record<string, unknown> = {}) => {
  useSessions.setState({
    activeSessionId: "s1",
    sessions: [],
    historySessions: [makeSessionRow({ sessionId: "s1", capabilities })],
    messages: { s1: [] },
  });
};

beforeEach(() => {
  resetStores();
});

describe("useChatSessionDerivations (the hook — the thin store-reading wrapper)", () => {
  it("a live session is live and the composer is enabled", () => {
    seedLive();
    const { result } = renderHook(() => useChatSessionDerivations());
    expect(result.current.isLive).toBe(true);
    expect(result.current.isHistoryOnly).toBe(false);
    expect(result.current.canResume).toBe(false);
    expect(result.current.composerEnabled).toBe(true);
  });

  it("a stored session WITHOUT `loadSession` is history-only and the composer cannot send", () => {
    seedHistoryOnly();
    const { result } = renderHook(() => useChatSessionDerivations());
    expect(result.current.isLive).toBe(false);
    expect(result.current.isHistoryOnly).toBe(true);
    expect(result.current.canResume).toBe(false);
    expect(result.current.composerEnabled).toBe(false);
  });

  it("a stored session WITH `loadSession: true` is resumable and the composer is enabled", () => {
    seedHistoryOnly({ loadSession: true });
    const { result } = renderHook(() => useChatSessionDerivations());
    expect(result.current.isHistoryOnly).toBe(true);
    expect(result.current.canResume).toBe(true);
    expect(result.current.composerEnabled).toBe(true);
  });

  it("an id NO list knows is neither live nor history-only", () => {
    useSessions.setState({ activeSessionId: "ghost" });
    const { result } = renderHook(() => useChatSessionDerivations());
    expect(result.current.isLive).toBe(false);
    expect(result.current.isHistoryOnly).toBe(false);
    expect(result.current.canResume).toBe(false);
    expect(result.current.composerEnabled).toBe(false);
  });

  it("splits the active session's interactive requests into the three lists", () => {
    seedLive();
    useInteractive.setState({
      requests: { s1: [ask("a1"), confirm("c1"), password("p1"), ask("a2")] },
    });
    const { result } = renderHook(() => useChatSessionDerivations());
    expect(result.current.askRequests.map((r) => r.requestId)).toEqual(["a1", "a2"]);
    expect(result.current.confirmRequests.map((r) => r.requestId)).toEqual(["c1"]);
    expect(result.current.passwordRequests.map((r) => r.requestId)).toEqual(["p1"]);
  });

  it("excludes an anchored ask from `stackedAskRequests` (a `main` ask whose `toolCallId` is in the transcript)", () => {
    seedLive();
    useSessions.setState({
      messages: { s1: [makeMessage("user"), makeMessage("tool-call", { id: "t1" })] },
    });
    useInteractive.setState({
      requests: { s1: [ask("a1", { toolCallId: "t1" }), ask("a2")] },
    });
    const { result } = renderHook(() => useChatSessionDerivations());
    expect([...result.current.anchoredAskRequestIds]).toEqual(["a1"]);
    expect(result.current.stackedAskRequests.map((r) => r.requestId)).toEqual(["a2"]);
  });

  it("collects the standalone `diff` messages of the current turn", () => {
    seedLive();
    useSessions.setState({
      messages: {
        s1: [
          makeMessage("user"),
          makeMessage("diff", { path: "a.ts", patch: "@@ -1 +1 @@" }),
          makeMessage("tool-call", { id: "t1", diff: { path: "x", patch: "y" } }),
          makeMessage("diff", { path: "b.ts", patch: "@@ -2 +2 @@" }),
        ],
      },
    });
    const { result } = renderHook(() => useChatSessionDerivations());
    expect(result.current.lastUserIndex).toBe(0);
    expect(result.current.turnDiffs).toEqual([
      { path: "a.ts", patch: "@@ -1 +1 @@" },
      { path: "b.ts", patch: "@@ -2 +2 @@" },
    ]);
  });

  it("`imageCapable` is true when the agent advertises `promptCapabilities.image`", () => {
    seedLive({ promptCapabilities: { image: true } });
    const { result } = renderHook(() => useChatSessionDerivations());
    expect(result.current.imageCapable).toBe(true);
  });

  it("`imageCapable` is false when capabilities carry no `promptCapabilities.image` (FAIL-CLOSED)", () => {
    // The bare `{}` the `makeSessionRow` fixture defaults to, and a capabilities
    // object that negotiates something ELSE, both take no images.
    seedLive({ loadSession: true });
    const { result } = renderHook(() => useChatSessionDerivations());
    expect(result.current.imageCapable).toBe(false);
  });

  it("the NO-SESSION state derives everything empty/false and does not throw", () => {
    // `activeSessionId` stays `null` (the reset's initial state) — the shape the
    // component short-circuits on, but the hook is called BEFORE that early
    // return, so it must answer for this frame.
    const { result } = renderHook(() => useChatSessionDerivations());
    expect(result.current.askRequests).toEqual([]);
    expect(result.current.confirmRequests).toEqual([]);
    expect(result.current.passwordRequests).toEqual([]);
    expect(result.current.stackedAskRequests).toEqual([]);
    expect([...result.current.anchoredAskRequestIds]).toEqual([]);
    expect(result.current.turnDiffs).toEqual([]);
    expect(result.current.lastUserIndex).toBe(-1);
    expect(result.current.isLive).toBe(false);
    expect(result.current.isHistoryOnly).toBe(false);
    expect(result.current.canResume).toBe(false);
    expect(result.current.composerEnabled).toBe(false);
    // Fail-closed: no capabilities at all → no images.
    expect(result.current.imageCapable).toBe(false);
  });

  it("the selector-stability rule holds: every `?? []` fallback sits OUTSIDE its selector, so an unrelated store write does not re-render the hook", () => {
    // A `?? []` / `?? {}` INSIDE a selector mints a fresh value per snapshot
    // read, which makes zustand v5 re-run the subscription forever (the rule at
    // `ChatStream.tsx:76-77`, restated in `sessionLookup.ts`'s invariant 2 —
    // "a selector may return the stored row but never a `{ … }` built per
    // snapshot"). The observable shape of that bug is a HANG rather than a
    // failure, so what is pinned here is the property the rule exists to keep:
    // the selectors read only the slices they need, and a write to a slice this
    // hook never selects leaves the render count alone.
    let renders = 0;
    // History-only + `loadSession` so the derivation has a non-trivial answer.
    seedHistoryOnly({ loadSession: true });
    const { result, rerender } = renderHook(
      () => {
        renders += 1;
        return useChatSessionDerivations();
      },
    );
    const baseline = renders;
    expect(baseline).toBeGreaterThan(0);
    // A write to a slice the hook does NOT select (`spaces` is not in any of its
    // six selectors): zustand re-runs the selectors, every one of them returns
    // the same reference, so no re-render happens.
    act(() => {
      useSessions.setState({ spaces: [makeSpaceRow({ path: "/w/other" })] });
    });
    expect(renders).toBe(baseline);
    // An explicit re-render still derives the same ANSWERS (the arrays are
    // re-derived per render on purpose — see the hook's no-`useMemo` note — so
    // the assertion is on the values, never on array identity).
    rerender();
    expect(result.current.isLive).toBe(false);
    expect(result.current.isHistoryOnly).toBe(true);
    expect(result.current.canResume).toBe(true);
    expect(result.current.composerEnabled).toBe(true);
    expect(result.current.turnDiffs).toEqual([]);
    expect(result.current.askRequests).toEqual([]);
    // And a write to a slice it DOES select re-renders (the pin above is not
    // simply "the hook is frozen").
    act(() => {
      useInteractive.setState({ requests: { s1: [ask("a1")] } });
    });
    expect(renders).toBeGreaterThan(baseline);
    expect(result.current.askRequests.map((r) => r.requestId)).toEqual(["a1"]);
  });
});
