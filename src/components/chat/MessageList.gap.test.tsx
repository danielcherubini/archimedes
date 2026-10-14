import { afterEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { createElement, type RefObject } from "react";
import MessageList from "./MessageList";
import type { RenderUnit } from "../../lib/toolGroups";
import type { Message } from "../../store/sessions";
import type { ChildGate } from "../../hooks/useChildGates";
import { useInteractive } from "../../store/interactive";

/**
 * The transcript's VERTICAL RHYTHM (ZCode's model: rows carry no padding and
 * the container owns the spacing — `gap-4` between work items, `gap-5` where
 * prose meets the work block, never per-row `py-*`).
 *
 * The ask: tool calls need more air around them than `Thought`/prose do —
 * prose and thinking stay as tight as they are, and a tool row gets a hidden
 * (margin, not border/band) breathing gap on each side it touches. So the gap
 * is a function of the PAIR: `base + breathing` whenever either neighbour is
 * a tool row, `base` otherwise.
 */

const text = (id: string): Message => ({
  kind: "agent-text",
  messageId: id,
  text: "hello",
  at: 1,
});
const thought = (id: string): Message => ({
  kind: "agent-thought",
  messageId: id,
  text: "thinking",
  at: 1,
});
const tool = (id: string, title = "bash"): Message => ({
  kind: "tool-call",
  id,
  title,
  status: "completed",
  at: 1,
});

const single = (message: Message): RenderUnit => ({ kind: "single", message });

/** The props every render in this file shares, so a new row type is added to
 * ONE fixture rather than re-typed per test. */
function renderMessageList(
  units: RenderUnit[],
  childGates: ChildGate[] = [],
): HTMLElement {
  const { container } = render(
    createElement(MessageList, {
      scrollRef: { current: null } as RefObject<HTMLDivElement | null>,
      units,
      messageCount: units.length,
      activeSessionId: "s1",
      inTurn: false,
      askRequests: [],
      prompts: [],
      stackedAskRequests: [],
      // The child-gate list defaults to `[]` because the rhythm tests below
      // index `scroll.children` POSITIONALLY from the FRONT and gate rows are
      // APPENDED LAST — but that is an ordering convenience, NOT a
      // restriction: `rowsWithGate` passes a real gate and the front-indexed
      // assertions still hold.
      childGates,
      hasPendingRequest: false,
      workingOrInTurn: false,
      agentState: "idle",
      turnDiffs: [],
      stopReason: undefined,
    }),
  );
  const scroll = container.querySelector('[data-testid="transcript-scroll"]');
  if (!scroll) throw new Error("no transcript scroll container");
  return scroll as HTMLElement;
}

function rows(units: RenderUnit[]): HTMLElement[] {
  return [...renderMessageList(units).children] as HTMLElement[];
}

/**
 * One child's pending `ask` gate — the row `MessageList` APPENDS after the
 * parent's own rows. The interactive store is seeded so the row holds a REAL
 * `AskQuestionCard` (the card renders `null` for a request the store does not
 * have, which would let this file pin an empty wrapper).
 */
function rowsWithGate(units: RenderUnit[] = [single(text("a"))]): HTMLElement[] {
  useInteractive.getState().addRequest("sub1", {
    requestId: "gate-r1",
    method: "ask",
    source: "subagent:reviewer",
    params: {
      questions: [
        { id: "q1", question: "Which color?", options: [{ label: "Red" }] },
      ],
    },
  });
  const gate: ChildGate = {
    childSessionId: "sub1",
    parentSessionId: "s1",
    agentName: "reviewer",
    requestId: "gate-r1",
    kind: "ask",
    params: {},
    childStartedAt: 1,
  };
  return [...renderMessageList(units, [gate]).children] as HTMLElement[];
}

afterEach(() => {
  useInteractive.getState().dismissSession("sub1");
});

const extra = (el: HTMLElement) =>
  el.className.split(/\s+/).filter((c) => /^(mt|my)-/.test(c));

describe("the transcript's vertical rhythm", () => {
  it("the container owns the base gap (a true `gap`, not `space-y` on a block box)", () => {
    const scroll = renderMessageList([single(text("a"))]);
    const tokens = scroll.className.split(/\s+/);
    expect(tokens).toContain("gap-3");
    expect(tokens).not.toContain("space-y-3");
    expect(tokens).toContain("overflow-x-hidden");
    expect(tokens).toContain("min-w-0");
    expect(tokens).toContain("max-w-full");
  });

  it("prose → tool: the tool row gets the breathing gap", () => {
    const [prose, toolRow] = rows([single(text("a")), single(tool("t1"))]);
    expect(extra(prose!)).toEqual([]);
    expect(extra(toolRow!)).toEqual(["mt-4"]);
  });

  it("tool → prose: the breathing gap is symmetric (it is the PAIR that is airy, not the tool row)", () => {
    const [, prose] = rows([single(tool("t1")), single(text("a"))]);
    expect(extra(prose!)).toEqual(["mt-4"]);
  });

  it("thinking → chat keeps the tight base gap (unchanged)", () => {
    const [thoughtRow, prose] = rows([
      single(thought("th")),
      single(text("a")),
    ]);
    expect(extra(thoughtRow!)).toEqual([]);
    expect(extra(prose!)).toEqual([]);
  });

  it("chat → thinking also stays tight", () => {
    const [, thoughtRow] = rows([single(text("a")), single(thought("th"))]);
    expect(extra(thoughtRow!)).toEqual([]);
  });

  it("tool → tool keeps ONE breathing gap (a run of tool calls is a steady 28px, not alternating)", () => {
    const [, second] = rows([single(tool("t1")), single(tool("t2"))]);
    expect(extra(second!)).toEqual(["mt-4"]);
  });

  it("a folded `Changes` group counts as a tool row", () => {
    const group: RenderUnit = {
      kind: "changes-group",
      messages: [tool("t1", "edit"), tool("t2", "write")] as never,
    };
    const [, prose] = rows([group, single(text("a"))]);
    expect(extra(prose!)).toEqual(["mt-4"]);
  });

  it("the FIRST row gets no breathing gap (the container's own padding is its air)", () => {
    const [first] = rows([single(tool("t1")), single(text("a"))]);
    expect(extra(first!)).toEqual([]);
  });

  it("every row is wrapped in a flex column so the row keeps its exact height (a block wrapper re-adds the line box's descender space)", () => {
    const [row] = rows([single(thought("th"))]);
    expect(row!.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["flex", "flex-col", "min-w-0", "max-w-full"]),
    );
  });

  // The CHILD-GATE row is a row type this file used to be blind to: it is
  // APPENDED after the parent's own rows, so every front-indexed assertion
  // above simply never looked at it (seeding a gate into the fixture left all of
  // them green). The pins below hold it to the same rhythm contract.
  it("a child gate is APPENDED as its own row (the fixture's front indices are unaffected, which is why the tests above could not see it)", () => {
    const withGate = rowsWithGate([single(text("a"))]);
    // One row for the parent's message, then the gate row LAST.
    expect(withGate).toHaveLength(2);
    expect(withGate[0]!.textContent).toContain("hello");
    // The gate row is the real card, attributed to the child.
    expect(withGate[1]!.textContent).toContain("↳ reviewer");
    expect(withGate[1]!.textContent).toContain("Which color?");
  });

  it("a child-gate row is wrapped in a flex column like every other row", () => {
    const withGate = rowsWithGate();
    const gateRow = withGate[withGate.length - 1]!;
    // Guarded so this cannot pass on some OTHER row when the gate render is
    // missing.
    expect(gateRow.textContent).toContain("Which color?");
    expect(gateRow.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["flex", "flex-col"]),
    );
  });

  it("a child-gate row NEVER breathes (gate rows are not tool rows, so they ride the base `gap-3`)", () => {
    // The precedent is the parent's own stacked cards (`prompts` /
    // `stackedAskRequests`): the breathing gap is a property of a PAIR that
    // touches a TOOL row, and a gate is not one. Give the gate row an `mt-*`
    // and the transcript gets a second, undocumented rhythm.
    const withGate = rowsWithGate([single(tool("t1")), single(text("a"))]);
    const gateRow = withGate[withGate.length - 1]!;
    expect(gateRow.textContent).toContain("Which color?");
    expect(extra(gateRow)).toEqual([]);
  });
});
