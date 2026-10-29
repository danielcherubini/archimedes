import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  childGateKey,
  childGatesOf,
  isInlineChildGate,
  useChildGates,
  type ChildGate,
} from "./useChildGates";
import {
  isInteractivePause,
  useInteractive,
  type InteractiveRequestData,
} from "../store/interactive";
import { usePermissions, type PermissionPromptData } from "../store/permissions";
import { useSubagents, type SubagentEntry } from "../store/subagents";

/**
 * `childGatesOf` is the ONE derivation of "which gates are the children of THIS
 * Session holding on the user, and who is holding them" — the inline card in
 * the parent's transcript, the always-mounted overlay, and the rail's dot all
 * read it, so they cannot disagree (the repo's standing rule; see
 * `useSessionStatus.ts`). The tests therefore drive the PURE core directly: a
 * hook cannot be called once per parent at a changing list length, and the
 * overlay needs "every child regardless of parent", which the single-parent
 * hook cannot express.
 */

const entry = (
  sessionId: string,
  parentSessionId: string,
  agentName: string,
  startedAt: number,
): SubagentEntry => ({
  sessionId,
  parentSessionId,
  agentName,
  task: `task for ${agentName}`,
  status: "running",
  startedAt,
});

const ask = (requestId: string, question = "which library?"): InteractiveRequestData => ({
  requestId,
  method: "ask",
  source: "subagent:reviewer",
  params: { question },
});

/** The store maps the pure core reads — fresh per call so a test cannot leak a
 * mutation into the next one. */
const none = (): {
  requests: Record<string, InteractiveRequestData[]>;
  prompts: Record<string, PermissionPromptData[]>;
} => ({ requests: {}, prompts: {} });

beforeEach(() => {
  useSubagents.setState({ entries: {} });
  useInteractive.setState({ requests: {} });
  usePermissions.setState({ prompts: {} });
});

describe("childGatesOf (the pure core — every consumer's single source)", () => {
  it("returns [] when there are no subagent entries", () => {
    const { requests, prompts } = none();
    expect(childGatesOf({}, requests, prompts, "main1")).toEqual([]);
  });

  it("surfaces a child's pending ask with its kind, agentName, childSessionId and parentSessionId", () => {
    const { requests, prompts } = none();
    requests.sub1 = [ask("r1")];
    const gates = childGatesOf(
      { sub1: entry("sub1", "main1", "reviewer", 1000) },
      requests,
      prompts,
      "main1",
    );
    expect(gates).toHaveLength(1);
    // The WHOLE gate, pinned with `toStrictEqual` so the FIELD SET is part of the
    // assertion: an `ask` carries the interactive half (`params`) and none of the
    // permission half (`toolTitle` / `options`), and it carries no `source` — the
    // store's `source` is a transport detail the backend fills with `native`,
    // which no consumer of a `ChildGate` reads, so the derivation does not
    // forward it (see the note on the type).
    expect(gates[0]).toStrictEqual({
      childSessionId: "sub1",
      parentSessionId: "main1",
      agentName: "reviewer",
      requestId: "r1",
      kind: "ask",
      params: { question: "which library?" },
      childStartedAt: 1000,
    });
  });

  it("surfaces a child's permission prompt with kind 'permission' and its toolTitle + options", () => {
    const { requests, prompts } = none();
    prompts.sub1 = [
      {
        requestId: "p1",
        toolTitle: "Run rm -rf /",
        options: [
          {
            optionId: "allow_once",
            name: "Allow once",
            path: "~/.pi/agent",
          },
        ],
      },
    ];
    const gates = childGatesOf(
      { sub1: entry("sub1", "main1", "reviewer", 1000) },
      requests,
      prompts,
      "main1",
    );
    expect(gates).toHaveLength(1);
    // The WHOLE gate, pinned with `toStrictEqual` so the field SET is the
    // assertion: a permission prompt contributes no interactive half (no
    // `params`, and no `source` either — `ChildGate` has no such field, and the
    // backend never emitted the `subagent:<name>` value one would have carried),
    // and a card must not read a question out of a prompt that has none.
    // The option's `path` (permissions-section T05) is in the field set on
    // purpose: `childGatesOf` pushes `options: p.options` BY REFERENCE, so the
    // subagent path carries the new field with zero plumbing — this pin is what
    // proves it.
    expect(gates[0]).toStrictEqual({
      childSessionId: "sub1",
      parentSessionId: "main1",
      agentName: "reviewer",
      requestId: "p1",
      kind: "permission",
      toolTitle: "Run rm -rf /",
      options: [
        {
          optionId: "allow_once",
          name: "Allow once",
          path: "~/.pi/agent",
        },
      ],
      childStartedAt: 1000,
    });
  });

  it("surfaces confirm and password too (all four kinds come from one derivation)", () => {
    const { requests, prompts } = none();
    requests.sub1 = [
      { requestId: "r1", method: "confirm", source: "subagent:reviewer", params: { command: "apt install ripgrep", reason: "install the tool" } },
      { requestId: "r2", method: "password", source: "subagent:reviewer", params: { command: "sudo apt install", reason: "needs root" } },
    ];
    const gates = childGatesOf(
      { sub1: entry("sub1", "main1", "reviewer", 1000) },
      requests,
      prompts,
      "main1",
    );
    expect(gates.map((g) => g.kind)).toEqual(["confirm", "password"]);
  });

  it("does NOT return a child of a DIFFERENT parent when a parent id is given (the inline card's scoping)", () => {
    const { requests, prompts } = none();
    requests.sub1 = [ask("r1")];
    requests.sub2 = [ask("r2")];
    const gates = childGatesOf(
      {
        sub1: entry("sub1", "main1", "reviewer", 1000),
        // Another Session's child — its gate belongs in THAT transcript.
        sub2: entry("sub2", "main2", "scout", 2000),
      },
      requests,
      prompts,
      "main1",
    );
    expect(gates.map((g) => g.childSessionId)).toEqual(["sub1"]);
  });

  it("parentSessionId: null returns EVERY child's gates — the pure core's 'all children' (the overlay's need, the OPPOSITE of the hook's null)", () => {
    const { requests, prompts } = none();
    requests.sub1 = [ask("r1")];
    requests.sub2 = [ask("r2")];
    const gates = childGatesOf(
      {
        sub1: entry("sub1", "main1", "reviewer", 1000),
        sub2: entry("sub2", "main2", "scout", 2000),
      },
      requests,
      prompts,
      null,
    );
    expect(gates.map((g) => g.childSessionId)).toEqual(["sub1", "sub2"]);
  });

  it("drops a gate whose child has no SubagentEntry (an evicted entry means an unknown parent — the gate has no home)", () => {
    const { requests, prompts } = none();
    // `sub1`'s entry was evicted by `MAX_CLOSED_ENTRIES`, so nothing here says
    // whose child it is — and this seed state is REACHABLE, not hypothetical: no
    // close clears a child's pending gates. `session-closed` has one emitter
    // (`on_session_exited_expected`, `src-tauri/src/agent/session/router.rs`) and
    // it needs a `live` entry, which only the main-session start/resume path
    // creates (`establish_worker_session`); a child's teardown is
    // `finish_subagent` (`src-tauri/src/agent/worker/manager.rs`), whose
    // `subagent-closed` handler in `App` marks the entry closed and discards its
    // messages but clears neither `useInteractive` nor `usePermissions`. So a
    // CLOSED child can still be sitting here with a live gate, and the entry's
    // eviction is the ONLY thing that retires it — which is why the drop is the
    // load-bearing rule rather than a last-ditch fallback. (Rust's
    // `cleanup_pending_modals` is NOT the net either: same missing `live` entry —
    // see ADR 0040's amendment.)
    requests.sub1 = [ask("r1")];
    prompts.sub1 = [{ requestId: "p1", toolTitle: "bash", options: [] }];
    expect(childGatesOf({}, requests, prompts, null)).toEqual([]);
    expect(childGatesOf({}, requests, prompts, "main1")).toEqual([]);
  });

  it("drops a request whose method is not a pause on the user (`isInteractivePause` is the ONE predicate that says so)", () => {
    // The `method` filter is a PROMISE about a future fourth
    // `InteractiveRequestData["method"]` (see the comment in `childGatesOf`), and
    // until now nothing tested it. The cast keeps the pin compiling on the day
    // the union grows — and it still fails today if the filter is deleted, which
    // is what makes it a pin rather than a type check.
    const { requests, prompts } = none();
    requests.sub1 = [
      {
        ...ask("r-progress"),
        method: "notify" as InteractiveRequestData["method"],
      },
      ask("r-ask"),
    ];
    const gates = childGatesOf(
      { sub1: entry("sub1", "main1", "reviewer", 1000) },
      requests,
      prompts,
      "main1",
    );
    expect(gates.map((g) => g.requestId)).toEqual(["r-ask"]);
    // The predicate lives in the store that OWNS the union, so the four consumers
    // (`childGatesOf`, `sessionStatusOf`, the attention snapshot,
    // `useHasPendingRequest`) cannot drift apart.
    expect(isInteractivePause("ask")).toBe(true);
    expect(isInteractivePause("confirm")).toBe(true);
    expect(isInteractivePause("password")).toBe(true);
    expect(isInteractivePause("notify" as InteractiveRequestData["method"])).toBe(
      false,
    );
  });

  it("orders by child arrival, then request arrival (two children, two asks each)", () => {
    const { requests, prompts } = none();
    // `subLate` arrives SECOND in wall-clock terms but is inserted into the
    // entries map FIRST — the sort key is `startedAt`, not map order.
    requests.subLate = [ask("l1", "first from late"), ask("l2", "second from late")];
    requests.subEarly = [ask("e1", "first from early"), ask("e2", "second from early")];
    const gates = childGatesOf(
      {
        subLate: entry("subLate", "main1", "scout", 2000),
        subEarly: entry("subEarly", "main1", "reviewer", 1000),
      },
      requests,
      prompts,
      "main1",
    );
    expect(gates.map((g) => g.requestId)).toEqual(["e1", "e2", "l1", "l2"]);
  });

  it("childGateKey is `${childSessionId}:${requestId}` (every consumer imports this exact string)", () => {
    const gate: ChildGate = {
      childSessionId: "sub1",
      parentSessionId: "main1",
      agentName: "reviewer",
      requestId: "r1",
      kind: "ask",
      childStartedAt: 1000,
    };
    expect(childGateKey(gate)).toBe("sub1:r1");
  });

  it("isInlineChildGate is `ask`/`permission` ONLY — the two kinds that draw a transcript row", () => {
    // `MessageList` filters its child-gate rows with this and `ChatStream`
    // counts inline gates with it for the auto-scroll dep, so ONE definition
    // keeps the count from including a gate that renders no row (a child's
    // `confirm`/`password` is an overlay `Dialog`).
    const gate = (kind: ChildGate["kind"]): ChildGate => ({
      childSessionId: "sub1",
      parentSessionId: "main1",
      agentName: "reviewer",
      requestId: "r1",
      kind,
      childStartedAt: 1000,
    });
    expect(isInlineChildGate(gate("ask"))).toBe(true);
    expect(isInlineChildGate(gate("permission"))).toBe(true);
    expect(isInlineChildGate(gate("confirm"))).toBe(false);
    expect(isInlineChildGate(gate("password"))).toBe(false);
  });
});

describe("useChildGates (the hook — the thin store-reading wrapper)", () => {
  it("THE HOOK returns [] for a null parentSessionId (no active session → nothing to scope to) — deliberately the OPPOSITE of childGatesOf(null), do not 'fix' the pure core to match", () => {
    useSubagents.setState({ entries: { sub1: entry("sub1", "main1", "reviewer", 1000) } });
    useInteractive.setState({ requests: { sub1: [ask("r1")] } });
    const { result } = renderHook(() => useChildGates(null));
    expect(result.current).toEqual([]);
  });

  it("hands back the SAME array on a re-render that changed no store (the derivation is memoised)", () => {
    // The array's identity must MEAN something: `useSessionStatus` calls this
    // once per unmemoized sidebar row (`SpacesList`'s `SessionRow`), so an array built
    // every render is re-derived — and re-sorted — once per row per render for
    // the same answer.
    //
    // What this pins is that THE MEMO EXISTS (this render did not re-derive). It
    // is NOT a contract consumers may rely on: `useMemo` is a hint React may in
    // principle discard, and `useChildGates`' own doc says identity must never be
    // read as correctness.
    useSubagents.setState({ entries: { sub1: entry("sub1", "main1", "reviewer", 1000) } });
    useInteractive.setState({ requests: { sub1: [ask("r1")] } });
    const { result, rerender } = renderHook(
      ({ parentId }: { parentId: string | null }) => useChildGates(parentId),
      { initialProps: { parentId: "main1" } },
    );
    const first = result.current;
    expect(first.map((g) => g.requestId)).toEqual(["r1"]);
    // A re-render with NO store write: same input refs, so same output array.
    rerender({ parentId: "main1" });
    expect(result.current).toBe(first);
    // A store write still produces a NEW array — the memo keys on the store
    // references, it does not cache an answer past the write.
    act(() => {
      useInteractive.getState().addRequest("sub1", ask("r2"));
    });
    rerender({ parentId: "main1" });
    expect(result.current).not.toBe(first);
    expect(result.current.map((g) => g.requestId)).toEqual(["r1", "r2"]);
  });

  it("reads the three stores and returns only the given parent's children's gates", () => {
    useSubagents.setState({
      entries: {
        sub1: entry("sub1", "main1", "reviewer", 1000),
        sub2: entry("sub2", "main2", "scout", 2000),
      },
    });
    useInteractive.setState({ requests: { sub1: [ask("r1")], sub2: [ask("r2")] } });
    usePermissions.setState({
      prompts: { sub1: [{ requestId: "p1", toolTitle: "bash", options: [] }] },
    });
    const { result } = renderHook(() => useChildGates("main1"));
    // Interactive gates before permission prompts for one child (the same
    // two-store order the attention snapshot uses).
    expect(result.current.map((g) => g.requestId)).toEqual(["r1", "p1"]);
    expect(result.current.every((g) => g.parentSessionId === "main1")).toBe(true);
  });
});
