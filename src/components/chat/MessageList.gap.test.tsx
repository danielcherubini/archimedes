import { afterEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { createElement } from "react";
import MessageList from "./MessageList";
import type { RenderUnit } from "../../lib/toolGroups";
import type { Message } from "../../store/sessions";
import type { ChildGate } from "../../hooks/useChildGates";
import type { InteractiveRequestData } from "../../store/interactive";
import { useInteractive } from "../../store/interactive";
import { useSessions } from "../../store/sessions";
import { resetStores } from "../../test/resetStores";

// NO `vi.mock("../../lib/tauri")` here, on purpose (see the same note in
// `MessageList.test.tsx`): the anchored ask card's self-cancelling effect
// swallows its own `invoke` failure (`.catch(() => {})`,
// `AskQuestionCard.tsx:315`), so the blank row renders identically without the
// seam — and `src/lib/tauriBarrel.test.ts:390` pins HOW MANY test files mock
// that barrel, a count this diagnostic task may not move.

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
  askRequests: InteractiveRequestData[] = [],
): HTMLElement {
  const { container } = render(
    createElement(MessageList, {
      units,
      messageCount: units.length,
      activeSessionId: "s1",
      inTurn: false,
      askRequests,
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
      hasMore: false,
      loadingMore: false,
      generation: 0,
      onStartReached: () => {},
    }),
  );
  const scroll = container.querySelector('[data-testid="transcript-scroll"]');
  if (!scroll) throw new Error("no transcript scroll container");
  return scroll as HTMLElement;
}

function rows(units: RenderUnit[]): HTMLElement[] {
  const scroll = renderMessageList(units);
  return [...scroll.querySelectorAll('[data-testid="message-row"]')] as HTMLElement[];
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
  const scroll = renderMessageList(units, [gate]);
  const messageRows = [...scroll.querySelectorAll('[data-testid="message-row"]')] as HTMLElement[];
  const gateRows = [...scroll.querySelectorAll('[data-testid="gate-row"]')] as HTMLElement[];
  return [...messageRows, ...gateRows];
}

afterEach(() => {
  useInteractive.getState().dismissSession("sub1");
});

const extra = (el: HTMLElement) =>
  el.className.split(/\s+/).filter((c) => /^pt-/.test(c));

describe("the transcript's vertical rhythm", () => {
  it("the scroll container is constrained to prevent horizontal blowout", () => {
    const scroll = renderMessageList([single(text("a"))]);
    const tokens = scroll.className.split(/\s+/);
    expect(tokens).toContain("overflow-x-hidden");
    expect(tokens).toContain("min-w-0");
    expect(tokens).toContain("max-w-full");
  });

  it("prose → tool: the tool row gets the breathing gap", () => {
    const [prose, toolRow] = rows([single(text("a")), single(tool("t1"))]);
    expect(extra(prose!)).toEqual([]);
    expect(extra(toolRow!)).toEqual(["pt-7"]);
  });

  it("tool → prose: the breathing gap is symmetric (it is the PAIR that is airy, not the tool row)", () => {
    const [, prose] = rows([single(tool("t1")), single(text("a"))]);
    expect(extra(prose!)).toEqual(["pt-7"]);
  });

  it("thinking → chat keeps the tight base gap (unchanged)", () => {
    const [thoughtRow, prose] = rows([
      single(thought("th")),
      single(text("a")),
    ]);
    expect(extra(thoughtRow!)).toEqual([]);
    expect(extra(prose!)).toEqual(["pt-3"]);
    // The wrapper carries NO margin on purpose — the breathing `mt-4` is a
    // property of a pair that touches a TOOL row, and a `Thought` is not one.
    // The tight 4px between the `Thought` and its reply therefore lives INSIDE
    // the row, on the reply's band: `-mt-2` (−8px) against the container's
    // `gap-3` (12px) is the only way below 12px, because a flex margin adds to a
    // gap and can never subtract from it. `mb-5` then opens the gap UNDER the
    // reply to 12 + 20 = 32px, the same air a user message leaves below it.
    const band = prose!.querySelector('[data-testid="agent-band"]');
    expect(band).not.toBeNull();
    const bandTokens = band!.className.split(/\s+/);
    expect(bandTokens).toContain("-mt-2");
    expect(bandTokens).toContain("mb-5");
  });

  it("chat → thinking also stays tight", () => {
    const [, thoughtRow] = rows([single(text("a")), single(thought("th"))]);
    expect(extra(thoughtRow!)).toEqual(["pt-3"]);
  });

  it("tool → tool keeps ONE breathing gap (a run of tool calls is a steady 28px, not alternating)", () => {
    const [, second] = rows([single(tool("t1")), single(tool("t2"))]);
    expect(extra(second!)).toEqual(["pt-7"]);
  });

  it("a folded `Changes` group counts as a tool row", () => {
    const group: RenderUnit = {
      kind: "changes-group",
      messages: [tool("t1", "edit"), tool("t2", "write")] as never,
    };
    const [, prose] = rows([group, single(text("a"))]);
    expect(extra(prose!)).toEqual(["pt-7"]);
  });

  it("the FIRST row gets no breathing gap (the container's own padding is its air)", () => {
    const [first] = rows([single(tool("t1")), single(text("a"))]);
    expect(extra(first!)).toEqual([]);
  });

  it("every row is wrapped in a flex column so the row keeps its exact height (a block wrapper re-adds the line box's descender space)", () => {
    const [row] = rows([single(thought("th"))]);
    expect(row!.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["flex", "flex-col", "min-w-0", "max-w-full", "px-4"]),
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

  /**
   * THE AMPLIFIER, disarmed (issue #86 — "empty/blank instead of hidden").
   *
   * `wrap()` pads whatever its child renders, so when the child was an
   * `AskQuestionCard` whose request had left the store the row kept the FULL
   * rhythm (`px-4` + the `pt-7` breathing gap) while holding no element at all.
   * FIXED: the anchored branch evaluates the card's own emptiness predicate
   * (`isAskRowRenderable`) at the CALL SITE and returns `null` for the whole
   * row, so a unit with nothing to draw contributes no row — the padded
   * wrapper is never emitted.
   *
   * Asserts row ABSENCE (never "no text content": an icon-only row also has
   * `textContent === ""` while showing a visible glyph), and pins the two
   * things the fix must NOT disturb — the surviving sibling row's rhythm, and
   * the class list of a row that DOES render (the flex column is load-bearing:
   * a block wrapper re-adds the line box's descender space).
   */
  describe("a dismissed ask row is not rendered at all (issue #86)", () => {
    afterEach(() => resetStores());

    it("the anchored unit contributes no row: no padded empty div survives", () => {
      resetStores();
      // The anchor: the tool-call message survives in the transcript...
      useSessions.setState({ messages: { s1: [tool("t1"), tool("call_ask")] } });
      // ...and the ask prop still lists the request the store no longer holds
      // (the durable version of the blank row — `removeRequest` cleared it).
      const stale: InteractiveRequestData = {
        requestId: "req-blank",
        method: "ask",
        source: "main",
        toolCallId: "call_ask",
        params: {
          questions: [{ id: "q1", question: "Which color?", options: [{ label: "Red" }] }],
        },
      };

      const scroll = renderMessageList(
        [single(tool("t1")), single(tool("call_ask"))],
        [],
        [stale],
      );
      const allRows = [
        ...(scroll.querySelectorAll('[data-testid="message-row"]') as NodeListOf<HTMLElement>),
      ];

      // NOT ONE row is padded-and-empty — the blank row is gone rather than
      // merely losing its padding.
      expect(allRows.filter((r) => r.childElementCount === 0)).toHaveLength(0);
      // And the anchored unit is simply absent: two units in, ONE row out.
      expect(allRows).toHaveLength(1);
      // The surviving row is the sibling tool row (unit 0 → no breathing gap),
      // so the fix removed a row rather than re-skinning the wrong one.
      const [sibling] = allRows;
      expect(sibling!.className.split(/\s+/)).toContain("px-4");
      expect(extra(sibling!)).toEqual([]);
      expect(sibling!.textContent).toContain("Ran");
    });

    it("a well-formed anchored ask still renders its card in a fully-rhythmed row", () => {
      resetStores();
      // The same two units, but the store HOLDS the request and it carries a
      // question — so the guard stays out of the way and the ask row keeps the
      // `pt-7` breathing gap the rhythm tests above pin for a tool pair.
      useSessions.setState({ messages: { s1: [tool("t1"), tool("call_ask")] } });
      const live: InteractiveRequestData = {
        requestId: "req-live",
        method: "ask",
        source: "main",
        toolCallId: "call_ask",
        params: {
          questions: [{ id: "q1", question: "Which color?", options: [{ label: "Red" }] }],
        },
      };
      useInteractive.getState().addRequest("s1", live);

      const scroll = renderMessageList(
        [single(tool("t1")), single(tool("call_ask"))],
        [],
        [live],
      );
      const allRows = [
        ...(scroll.querySelectorAll('[data-testid="message-row"]') as NodeListOf<HTMLElement>),
      ];

      expect(allRows).toHaveLength(2);
      const askRow = allRows[1]!;
      expect(askRow.textContent).toContain("Which color?");
      // Tool → tool, so the row that DOES draw keeps the breathing gap, and it
      // is still the flex column every other row is.
      expect(extra(askRow)).toEqual(["pt-7"]);
      expect(askRow.className.split(/\s+/)).toEqual(
        expect.arrayContaining(["flex", "flex-col", "min-w-0", "max-w-full", "px-4"]),
      );
    });
  });
});
