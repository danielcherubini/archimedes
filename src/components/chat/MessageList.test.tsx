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
 * CHARACTERISATION (issue #86 — "just empty/blank instead of hidden").
 *
 * These tests assert what renders TODAY, not what should render. The shape the
 * reporter described is a transcript row that occupies its padded space and
 * shows nothing, and the one path that reaches it through production code is
 * the ASK-ANCHORED row: `MessageList.tsx:299-308` swaps the tool card out for
 * an `<AskQuestionCard>` whenever a `main` ask request is anchored to the tool
 * call's `id`, and `AskQuestionCard.tsx:319` returns `null` for a request that
 * is gone from the store or carries zero questions. `wrap()` never inspects its
 * child, so the padded `message-row` div survives the `null`.
 *
 * Task 2 inverts these assertions (no `message-row` at all for such a unit).
 * Until then they PASS by proving `row.childElementCount === 0` — the row
 * exists and holds no element, which is the blank row.
 *
 * `childElementCount` and never `textContent`: an icon-only row also has an
 * empty `textContent` while visibly showing a glyph, so a text-based assertion
 * conflates "nothing is drawn" with "only a glyph is drawn".
 */
describe("the ask-anchored row renders nothing when the ask has nothing to draw (issue #86, characterisation)", () => {
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
    return [
      ...(container.querySelectorAll('[data-testid="message-row"]') as NodeListOf<HTMLElement>),
    ];
  }

  it("a request present with questions: [] leaves a padded row containing NO element", () => {
    // The tool-call message exists (the anchor) AND the store holds the request
    // — the exact precondition `MessageList.tsx:299-308` needs to prefer the
    // ask card over the tool card.
    useSessions.setState({ messages: { s1: [toolMsg("call_ask")] } });
    useInteractive.getState().addRequest("s1", anchoredAsk({ questions: [] }));

    const rows = renderAnchored([anchoredAsk({ questions: [] })]);

    // The row is there — one per unit — and it is the ask row, not the tool
    // card (a tool card would render a <button> with a verb).
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.childElementCount).toBe(0);
    // Nothing at all inside: no element, no text node.
    expect(row.childNodes).toHaveLength(0);
    // And the ask card's only testid is never reached, because the card
    // returned null before rendering its footer.
    expect(screen.queryByTestId("ask-footer")).toBeNull();
    // The tool card did NOT render either — so the row is blank, not swapped.
    expect(screen.queryByText("Ran")).toBeNull();
  });

  it("a dismissed request (removeRequest) leaves the anchored row padded and containing NO element", () => {
    // The durable version of the same blank row: the anchor's tool-call message
    // outlives the answer, so if `askRequests` (the prop the row reads) still
    // lists a request the STORE no longer has, `AskQuestionCard.tsx:319`'s
    // `!request` arm fires and the row keeps its padding.
    useSessions.setState({ messages: { s1: [toolMsg("call_ask")] } });
    useInteractive.getState().addRequest("s1", anchoredAsk({
      questions: [{ id: "q1", question: "Which file?", options: [{ label: "A" }] }],
    }));
    useInteractive.getState().removeRequest("s1", "req-blank");

    const rows = renderAnchored([anchoredAsk({
      questions: [{ id: "q1", question: "Which file?", options: [{ label: "A" }] }],
    })]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.childElementCount).toBe(0);
    expect(rows[0]!.childNodes).toHaveLength(0);
    // Proof it is the removed-request arm and not a rendering of the question:
    expect(screen.queryByText("Which file?")).toBeNull();
  });
});
