import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import MessageList from "./MessageList";
import type { RenderUnit } from "../../lib/toolGroups";
import type { Message } from "../../store/sessions";
import type { InteractiveRequestData } from "../../store/interactive";
import { useInteractive } from "../../store/interactive";
import { useSessions } from "../../store/sessions";

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

  it("renders Start of conversation header when !hasMore", () => {
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

    expect(screen.getByText("Start of conversation")).toBeTruthy();
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

    expect(screen.queryByText("Start of conversation")).toBeNull();
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

    expect(screen.queryByText("Start of conversation")).toBeNull();
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
