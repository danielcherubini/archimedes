import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import MessageList from "./MessageList";
import type { RenderUnit } from "../../lib/toolGroups";
import type { Message } from "../../store/sessions";
import type { InteractiveRequestData } from "../../store/interactive";
import { useInteractive } from "../../store/interactive";
import { useSessions } from "../../store/sessions";
import { resetStores } from "../../test/resetStores";

// NO `vi.mock("../../lib/tauri")` here, on purpose. The zero-questions case
// below fires `AskQuestionCard`'s self-cancelling effect, whose `invoke` fails
// in jsdom — and the card already swallows it (`.catch(() => {})`,
// `AskQuestionCard.tsx:315`), so the render is unaffected. Mocking the barrel
// from a new file is additionally a pinned-count change in
// `src/lib/tauriBarrel.test.ts:390`, which this diagnostic task may not touch.

const textMsg = (id: string, text = "hello"): Message => ({
  kind: "agent-text",
  messageId: id,
  text,
  at: 1,
});

const toolMsg = (id: string, title = "bash"): Message => ({
  kind: "tool-call",
  id,
  title,
  status: "completed",
  at: 1,
});

const single = (message: Message): RenderUnit => ({ kind: "single", message });

describe("MessageList", () => {
  it("renders empty state when units is empty", () => {
    render(
      <MessageList
        units={[]}
        activeSessionId="s1"
        inTurn={false}
        askRequests={[]}
        prompts={[]}
        stackedAskRequests={[]}
        childGates={[]}
        hasPendingRequest={false}
        workingOrInTurn={false}
        agentState="idle"
        turnDiffs={[]}
        stopReason={undefined}
        hasMore={false}
        loadingMore={false}
        generation={0}
        onStartReached={() => {}}
      />,
    );

    expect(screen.getByText("Send a prompt to start")).toBeTruthy();
  });

  it("does not render 'Send a prompt to start' when hasPendingRequest is true", () => {
    render(
      <MessageList
        units={[]}
        activeSessionId="s1"
        inTurn={false}
        askRequests={[]}
        prompts={[]}
        stackedAskRequests={[]}
        childGates={[]}
        hasPendingRequest={true}
        workingOrInTurn={false}
        agentState="idle"
        turnDiffs={[]}
        stopReason={undefined}
        hasMore={false}
        loadingMore={false}
        generation={0}
        onStartReached={() => {}}
      />,
    );

    expect(screen.queryByText("Send a prompt to start")).toBeNull();
  });

  it("renders Start of session header when !hasMore", () => {
    render(
      <MessageList
        units={[single(textMsg("m1"))]}
        activeSessionId="s1"
        inTurn={false}
        askRequests={[]}
        prompts={[]}
        stackedAskRequests={[]}
        childGates={[]}
        hasPendingRequest={false}
        workingOrInTurn={false}
        agentState="idle"
        turnDiffs={[]}
        stopReason={undefined}
        hasMore={false}
        loadingMore={false}
        generation={0}
        onStartReached={() => {}}
      />,
    );

    expect(screen.getByText("Start of session")).toBeTruthy();
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("renders loading spinner when loadingMore", () => {
    render(
      <MessageList
        units={[single(textMsg("m1"))]}
        activeSessionId="s1"
        inTurn={false}
        askRequests={[]}
        prompts={[]}
        stackedAskRequests={[]}
        childGates={[]}
        hasPendingRequest={false}
        workingOrInTurn={false}
        agentState="idle"
        turnDiffs={[]}
        stopReason={undefined}
        hasMore={true}
        loadingMore={true}
        generation={0}
        onStartReached={() => {}}
      />,
    );

    expect(screen.queryByText("Start of session")).toBeNull();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("renders empty header spacer when hasMore is true but not loadingMore with fixed-height container", () => {
    const { container } = render(
      <MessageList
        units={[single(textMsg("m1"))]}
        activeSessionId="s1"
        inTurn={false}
        askRequests={[]}
        prompts={[]}
        stackedAskRequests={[]}
        childGates={[]}
        hasPendingRequest={false}
        workingOrInTurn={false}
        agentState="idle"
        turnDiffs={[]}
        stopReason={undefined}
        hasMore={true}
        loadingMore={false}
        generation={0}
        onStartReached={() => {}}
      />,
    );

    expect(screen.queryByText("Start of session")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    const headerWrapper = container.querySelector(".pt-4");
    expect(headerWrapper).toBeTruthy();
    expect(headerWrapper?.querySelector(".h-6")).toBeTruthy();
  });

  it("renders ChangesGroupCard for changes-group units", () => {
    const group: RenderUnit = {
      kind: "changes-group",
      messages: [toolMsg("t1", "edit"), toolMsg("t2", "write")] as never,
    };
    render(
      <MessageList
        units={[group]}
        activeSessionId="s1"
        inTurn={false}
        askRequests={[]}
        prompts={[]}
        stackedAskRequests={[]}
        childGates={[]}
        hasPendingRequest={false}
        workingOrInTurn={false}
        agentState="idle"
        turnDiffs={[]}
        stopReason={undefined}
        hasMore={false}
        loadingMore={false}
        generation={0}
        onStartReached={() => {}}
      />,
    );

    expect(screen.getByText("Changes")).toBeTruthy();
  });

  it("renders AskQuestionCard for an anchored main ask request", () => {
    useSessions.setState({
      messages: {
        s1: [toolMsg("call_ask")],
      },
    });
    useInteractive.getState().addRequest("s1", {
      requestId: "req-ask-1",
      method: "ask",
      source: "main",
      toolCallId: "call_ask",
      params: {
        questions: [{ id: "q1", question: "Which file?", options: [{ label: "A" }] }],
      },
    });

    const askReq: InteractiveRequestData = {
      requestId: "req-ask-1",
      method: "ask",
      source: "main",
      toolCallId: "call_ask",
      params: { questions: [] },
    };

    render(
      <MessageList
        units={[single(toolMsg("call_ask"))]}
        activeSessionId="s1"
        inTurn={false}
        askRequests={[askReq]}
        prompts={[]}
        stackedAskRequests={[]}
        childGates={[]}
        hasPendingRequest={true}
        workingOrInTurn={false}
        agentState="idle"
        turnDiffs={[]}
        stopReason={undefined}
        hasMore={false}
        loadingMore={false}
        generation={0}
        onStartReached={() => {}}
      />,
    );

    expect(screen.getByText("Which file?")).toBeTruthy();
    useInteractive.getState().dismissSession("s1");
  });

  it("renders footer with stop reason when turn has ended abnormally", () => {
    render(
      <MessageList
        units={[single(textMsg("m1"))]}
        activeSessionId="s1"
        inTurn={false}
        askRequests={[]}
        prompts={[]}
        stackedAskRequests={[]}
        childGates={[]}
        hasPendingRequest={false}
        workingOrInTurn={false}
        agentState="idle"
        turnDiffs={[]}
        stopReason="max_tokens"
        hasMore={false}
        loadingMore={false}
        generation={0}
        onStartReached={() => {}}
      />,
    );

    expect(screen.getByText("Turn ended: max_tokens")).toBeTruthy();
  });
});

/**
 * THE INVARIANT (issue #86 — "just empty/blank instead of hidden").
 *
 * The shape the reporter described was a transcript row that occupied its
 * padded space and showed nothing, reached through the ASK-ANCHORED row:
 * `MessageList` swaps the tool card out for an `<AskQuestionCard>` whenever a
 * `main` ask request is anchored to the tool call's `id`, and the card renders
 * `null` for a request that is gone from the store or carries zero questions.
 * `wrap()` used to never inspect its child, so the padded `message-row` div
 * survived the `null`.
 *
 * FIXED (Task 2): the anchored branch evaluates the card's own emptiness
 * predicate (`isAskRowRenderable`) at the call site and returns `null` for the
 * whole row, so such a unit contributes NO row at all — hidden, not blank.
 * These tests assert that invariant.
 *
 * `childElementCount` / row absence and never `textContent`: an icon-only row
 * also has an empty `textContent` while visibly showing a glyph, so a
 * text-based assertion conflates "nothing is drawn" with "only a glyph is
 * drawn".
 */
describe("an ask-anchored unit with nothing to draw contributes no row at all (issue #86)", () => {
  beforeEach(() => {
    // `AGENTS.md`: this suite inherits neighbour state — several describes never
    // reset, so a store-reading test must reset explicitly.
    resetStores();
  });

  afterEach(() => {
    // The zero-questions case fires the card's self-cancelling effect, which
    // calls `removeRequest` on a microtask — leave nothing behind for the next
    // file that reads these stores.
    resetStores();
  });

  /** The anchored ask request the two cases below differ only in. */
  const anchoredAsk = (params: Record<string, unknown>): InteractiveRequestData => ({
    requestId: "req-blank",
    method: "ask",
    source: "main",
    toolCallId: "call_ask",
    params,
  });

  /** Render a single `tool-call` unit that the ask anchors to. */
  function renderAnchored(askRequests: InteractiveRequestData[]) {
    const { container } = render(
      <MessageList
        units={[single(toolMsg("call_ask"))]}
        activeSessionId="s1"
        inTurn={false}
        askRequests={askRequests}
        prompts={[]}
        stackedAskRequests={[]}
        childGates={[]}
        hasPendingRequest={askRequests.length > 0}
        workingOrInTurn={false}
        agentState="idle"
        turnDiffs={[]}
        stopReason={undefined}
        hasMore={false}
        loadingMore={false}
        generation={0}
        onStartReached={() => {}}
      />,
    );
    const rows = [
      ...(container.querySelectorAll('[data-testid="message-row"]') as NodeListOf<HTMLElement>),
    ];
    return { container, rows };
  }

  it("a request present with questions: [] renders NO row for the anchored unit", () => {
    // The tool-call message exists (the anchor) AND the store holds the request
    // — the exact precondition `MessageList`'s anchored branch needs to prefer
    // the ask card over the tool card. The card has nothing to draw, so the
    // call site refuses the row: hidden, not padded-and-blank (issue #86).
    useSessions.setState({ messages: { s1: [toolMsg("call_ask")] } });
    useInteractive.getState().addRequest("s1", anchoredAsk({ questions: [] }));

    const { rows } = renderAnchored([anchoredAsk({ questions: [] })]);

    // No row at all for the single unit — the padded empty div is gone.
    expect(rows).toHaveLength(0);
    // And nothing was padded-and-empty behind it: not one row exists, so there
    // is no row that could hold zero elements.
    expect(screen.queryAllByTestId("message-row")).toHaveLength(0);
    // The ask card's only testid is never reached (it has no questions), and
    // the tool card did NOT render in its place either — the unit is skipped.
    expect(screen.queryByTestId("ask-footer")).toBeNull();
    expect(screen.queryByText("Ran")).toBeNull();
  });

  it("a dismissed request (removeRequest) renders NO row for the anchored unit", () => {
    // The durable version of the old blank row: the anchor's tool-call message
    // outlives the answer, so `askRequests` (the prop the row reads) can still
    // list a request the STORE no longer has. `isAskRowRenderable`'s `!request`
    // arm now fires at the CALL SITE, so no row is emitted at all.
    useSessions.setState({ messages: { s1: [toolMsg("call_ask")] } });
    useInteractive.getState().addRequest("s1", anchoredAsk({
      questions: [{ id: "q1", question: "Which file?", options: [{ label: "A" }] }],
    }));
    useInteractive.getState().removeRequest("s1", "req-blank");

    const { rows } = renderAnchored([anchoredAsk({
      questions: [{ id: "q1", question: "Which file?", options: [{ label: "A" }] }],
    })]);

    expect(rows).toHaveLength(0);
    expect(screen.queryAllByTestId("message-row")).toHaveLength(0);
    // Proof it is the removed-request arm and not a rendering of the question:
    expect(screen.queryByText("Which file?")).toBeNull();
  });

  it("a well-formed ask request still renders its card inside a row, exactly as before", () => {
    // The POSITIVE case — the guard must not swallow a real ask. The request is
    // in the store AND carries a question, so the anchored row renders the card
    // in the same padded `message-row` wrapper every other row uses.
    useSessions.setState({ messages: { s1: [toolMsg("call_ask")] } });
    useInteractive.getState().addRequest("s1", anchoredAsk({
      questions: [{ id: "q1", question: "Which file?", options: [{ label: "A" }] }],
    }));

    const { rows } = renderAnchored([anchoredAsk({
      questions: [{ id: "q1", question: "Which file?", options: [{ label: "A" }] }],
    })]);

    // Exactly one row — the anchored unit's — and it is not empty.
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.childElementCount).toBeGreaterThan(0);
    expect(row.textContent).toContain("Which file?");
    // The card's own footer is present, so this is the real card and not a
    // placeholder, and the row is the standard flex-column rhythm wrapper.
    expect(screen.getByTestId("ask-footer")).toBeTruthy();
    expect(row.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["flex", "flex-col", "min-w-0", "max-w-full", "px-4"]),
    );
  });
});
