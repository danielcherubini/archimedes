import { describe, expect, it } from "vitest";
import {
  anchoredAskRequestIds,
  classifyInteractiveRequests,
  composerLockDerivations,
  historyPaginationDerivations,
  sessionKindDerivations,
  stackedAskRequests,
  turnDiffs,
} from "./chatSessionDerivations";
import type { InteractiveRequestData } from "../store/interactive";
import { makeMessage, makeSessionRow } from "../test/fixtures";

/**
 * The PURE core of the session/capability derivations (issue #135 §3), driven
 * directly — no store, no render, no `vi.mock` (the precedents
 * `useChildGates.test.ts` / `useSessionStatus.test.ts` mock nothing either).
 *
 * Every case pins the BYTE-IDENTICAL behaviour the component used to run inline,
 * so a "fix" while moving shows up as a failure here rather than as a silent
 * behaviour change in `ChatStream.tsx`.
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

describe("classifyInteractiveRequests", () => {
  it("splits a mixed list into the three arrays by `method`", () => {
    const requests: InteractiveRequestData[] = [
      ask("a1"),
      { requestId: "c1", method: "confirm", source: "main", params: {} },
      ask("a2"),
      { requestId: "p1", method: "password", source: "main", params: {} },
      { requestId: "c2", method: "confirm", source: "main", params: {} },
    ];
    const { askRequests, confirmRequests, passwordRequests } =
      classifyInteractiveRequests(requests);
    expect(askRequests.map((r) => r.requestId)).toEqual(["a1", "a2"]);
    expect(confirmRequests.map((r) => r.requestId)).toEqual(["c1", "c2"]);
    expect(passwordRequests.map((r) => r.requestId)).toEqual(["p1"]);
  });

  it("returns three empty arrays for an empty list", () => {
    expect(classifyInteractiveRequests([])).toEqual({
      askRequests: [],
      confirmRequests: [],
      passwordRequests: [],
    });
  });
});

describe("anchoredAskRequestIds", () => {
  it("anchors a `main` ask whose `toolCallId` matches a `tool-call` message id", () => {
    const anchored = anchoredAskRequestIds(
      [ask("a1", { toolCallId: "t1" })],
      [makeMessage("tool-call", { id: "t1" })],
    );
    expect([...anchored]).toEqual(["a1"]);
  });

  it("does NOT anchor the same ask when no message carries its `toolCallId`", () => {
    const anchored = anchoredAskRequestIds(
      [ask("a1", { toolCallId: "t9" })],
      [makeMessage("tool-call", { id: "t1" })],
    );
    expect(anchored.size).toBe(0);
  });

  it("does NOT anchor a NON-`main` ask even when its `toolCallId` matches (the `source === \"main\"` gate)", () => {
    // The desktop has no ACP `tool_call` frame for child tool calls, so a child
    // ask can never anchor — this is the gate, not an accident of the data.
    const anchored = anchoredAskRequestIds(
      [ask("a1", { toolCallId: "t1", source: "child" })],
      [makeMessage("tool-call", { id: "t1" })],
    );
    expect(anchored.size).toBe(0);
  });

  it("does NOT anchor a `toolCallId`-less ask", () => {
    const anchored = anchoredAskRequestIds(
      [ask("a1")],
      [makeMessage("tool-call", { id: "t1" })],
    );
    expect(anchored.size).toBe(0);
  });
});

describe("stackedAskRequests", () => {
  it("excludes the anchored ids, keeps the rest in arrival order", () => {
    const askRequests = [
      ask("a1", { toolCallId: "t1" }),
      ask("a2"),
      ask("a3", { toolCallId: "t2" }),
    ];
    const anchored = new Set(["a1", "t-nothing"]);
    expect(stackedAskRequests(askRequests, anchored).map((r) => r.requestId)).toEqual([
      "a2",
      "a3",
    ]);
  });
});

describe("sessionKindDerivations", () => {
  it("a live session is live: composer enabled, not history-only, no resume needed", () => {
    expect(
      sessionKindDerivations({
        liveSession: makeSessionRow({ sessionId: "s1" }),
        activeSessionIsKnown: true,
        activeCapabilities: undefined,
      }),
    ).toEqual({
      isLive: true,
      isHistoryOnly: false,
      canResume: false,
      composerEnabled: true,
    });
  });

  it("a known-but-not-live session without capabilities is history-only and cannot send", () => {
    expect(
      sessionKindDerivations({
        liveSession: undefined,
        activeSessionIsKnown: true,
        activeCapabilities: undefined,
      }),
    ).toEqual({
      isLive: false,
      isHistoryOnly: true,
      canResume: false,
      composerEnabled: false,
    });
  });

  it("a known-but-not-live session with `loadSession: true` is resumable and the composer sends", () => {
    expect(
      sessionKindDerivations({
        liveSession: undefined,
        activeSessionIsKnown: true,
        activeCapabilities: { loadSession: true },
      }),
    ).toEqual({
      isLive: false,
      isHistoryOnly: true,
      canResume: true,
      composerEnabled: true,
    });
  });

  it("`loadSession: false` is NOT resumable (the `=== true` strictness)", () => {
    const kind = sessionKindDerivations({
      liveSession: undefined,
      activeSessionIsKnown: true,
      activeCapabilities: { loadSession: false },
    });
    expect(kind.canResume).toBe(false);
    expect(kind.composerEnabled).toBe(false);
  });

  it("an id NO list knows is neither live nor history-only, and cannot send", () => {
    // `canResume` is asserted here on purpose: it is
    // `isHistoryOnly && activeCapabilities?.loadSession === true`, so a future
    // `isHistoryOnly = activeSessionIsKnown` typo would stay green if only
    // `composerEnabled` were checked.
    expect(
      sessionKindDerivations({
        liveSession: undefined,
        activeSessionIsKnown: false,
        activeCapabilities: { loadSession: true },
      }),
    ).toEqual({
      isLive: false,
      isHistoryOnly: false,
      canResume: false,
      composerEnabled: false,
    });
  });
});

describe("turnDiffs", () => {
  it("a transcript ending in a `user` message has that index and no diffs", () => {
    const messages = [
      makeMessage("user"),
      makeMessage("agent-text"),
      makeMessage("user"),
    ];
    expect(turnDiffs(messages)).toEqual({ lastUserIndex: 2, turnDiffs: [] });
  });

  it("collects the standalone `diff` messages after the last `user`", () => {
    const messages = [
      makeMessage("diff", { path: "before.ts", patch: "@@ old @@" }),
      makeMessage("user"),
      makeMessage("diff", { path: "a.ts", patch: "@@ -1 +1 @@" }),
      makeMessage("agent-text"),
      makeMessage("diff", { path: "b.ts", patch: "@@ -2 +2 @@" }),
    ];
    expect(turnDiffs(messages)).toEqual({
      lastUserIndex: 1,
      turnDiffs: [
        { path: "a.ts", patch: "@@ -1 +1 @@" },
        { path: "b.ts", patch: "@@ -2 +2 @@" },
      ],
    });
  });

  it("does NOT collect a `tool-call`'s own `diff` field (summing both would count every file twice)", () => {
    const messages = [
      makeMessage("user"),
      makeMessage("tool-call", { id: "t1", diff: { path: "x", patch: "y" } }),
    ];
    const out = turnDiffs(messages);
    expect(out.lastUserIndex).toBe(0);
    expect(out.turnDiffs).toEqual([]);
  });

  it("no `user` message at all → lastUserIndex -1 and no diffs", () => {
    const messages = [makeMessage("agent-text"), makeMessage("diff")];
    expect(turnDiffs(messages)).toEqual({ lastUserIndex: -1, turnDiffs: [] });
  });

  it("an empty transcript → lastUserIndex -1 and no diffs", () => {
    expect(turnDiffs([])).toEqual({ lastUserIndex: -1, turnDiffs: [] });
  });
});

describe("composerLockDerivations", () => {
  it("a `working` agent with a turn in flight locks the composer (both flags true)", () => {
    expect(
      composerLockDerivations({ agentState: "working", inTurn: true, compacting: undefined }),
    ).toEqual({ workingOrInTurn: true, composerLocked: true });
  });

  it("a `working` agent WITHOUT an in-flight turn still locks (a STALE `working` must not unlock)", () => {
    // The chain's ground-truth rule: the store does not reset `agentState` on
    // `turnCompleted`, so a stale `working` from the previous turn keeps the
    // SEND disabled — `workingOrInTurn` is `agentState === "working" || inTurn`,
    // and the `working` term alone carries the lock.
    expect(
      composerLockDerivations({ agentState: "working", inTurn: false, compacting: undefined }),
    ).toEqual({ workingOrInTurn: true, composerLocked: true });
  });

  it("a `blocked` agent locks WITHOUT an in-flight turn (the term `inTurn` alone would miss)", () => {
    // `agentState === "blocked"` covers a blocked state with no turn recorded —
    // `inTurn` alone would leave the composer unlocked there.
    expect(
      composerLockDerivations({ agentState: "blocked", inTurn: false, compacting: undefined }),
    ).toEqual({ workingOrInTurn: false, composerLocked: true });
  });

  it("an idle agent with no turn and no compaction unlocks the composer", () => {
    expect(
      composerLockDerivations({ agentState: "idle", inTurn: false, compacting: undefined }),
    ).toEqual({ workingOrInTurn: false, composerLocked: false });
  });

  it("an in-flight compaction locks the composer (ADR 0045: the harness is one-turn-at-a-time)", () => {
    // An idle compaction emits no `turn_start` / `agent_settled`, so neither
    // `inTurn` nor `agentState` says "working" — `compacting !== undefined` is
    // the ONLY signal. One `CompactionReason` value pins the value-uniform
    // `!== undefined` term (`"manual" | "threshold" | "overflow"` behave alike).
    expect(
      composerLockDerivations({ agentState: "idle", inTurn: false, compacting: "manual" }),
    ).toEqual({ workingOrInTurn: false, composerLocked: true });
  });
});

describe("historyPaginationDerivations", () => {
  it("returns the window's three fields and passes `loadOlder` through by IDENTITY", () => {
    // IDENTITY is the load-bearing half: `MessageList`'s `onStartReached` closes
    // over this function value, and the store action is a stable reference. The
    // action is NEVER invoked here (it reaches the `load_history` IPC command).
    const loadOlder = async (_sessionId: string) => {};
    const out = historyPaginationDerivations({
      history: { oldestRowId: 1, hasMore: true, loadingMore: false, generation: 3, epoch: 0 },
      loadOlder,
    });
    expect(out.hasMore).toBe(true);
    expect(out.loadingMore).toBe(false);
    expect(out.generation).toBe(3);
    expect(out.loadOlder).toBe(loadOlder);
  });
});
