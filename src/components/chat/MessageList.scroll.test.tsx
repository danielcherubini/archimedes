import { useImperativeHandle } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import MessageList, { type MessageListProps } from "./MessageList";
import type { RenderUnit } from "../../lib/toolGroups";
import type { Message } from "../../store/sessions";
import type { PermissionPromptData } from "../../store/permissions";

const virtuosoHandleRef = {
  scrollToIndex: vi.fn(),
  autoscrollToBottom: vi.fn(),
};

let capturedVirtuosoProps: any = null;

vi.mock("react-virtuoso", () => {
  const VirtuosoStandIn = (props: any) => {
    capturedVirtuosoProps = props;
    useImperativeHandle(props.ref, () => virtuosoHandleRef, []);
    const { Header, Footer } = props.components ?? {};
    return (
      <div data-testid="virtuoso-stand-in" className={props.className}>
        {Header && <Header context={props.context} />}
        {props.data?.map((item: any, i: number) => {
          const itemIndex = (props.firstItemIndex ?? 0) + i;
          const key = props.computeItemKey
            ? props.computeItemKey(itemIndex, item, props.context)
            : i;
          return (
            <div key={key}>
              {props.itemContent
                ? props.itemContent(itemIndex, item, props.context)
                : null}
            </div>
          );
        })}
        {Footer && <Footer context={props.context} />}
      </div>
    );
  };

  return {
    Virtuoso: VirtuosoStandIn,
  };
});

let rafIdCounter = 1;
const pendingRafCallbacks = new Map<number, FrameRequestCallback>();

function stubRaf() {
  pendingRafCallbacks.clear();
  rafIdCounter = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = rafIdCounter++;
    pendingRafCallbacks.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    pendingRafCallbacks.delete(id);
  });
}

function flushRaf() {
  const cbs = Array.from(pendingRafCallbacks.values());
  pendingRafCallbacks.clear();
  cbs.forEach((cb) => cb(performance.now()));
}

const textMsg = (id: string, text = "hello", at = 1): Message => ({
  kind: "agent-text",
  messageId: id,
  text,
  at,
});

const userMsg = (text = "user input", at = 1): Message => ({
  kind: "user",
  text,
  at,
});

const single = (message: Message): RenderUnit => ({ kind: "single", message });

function makeProps(overrides: Partial<MessageListProps> = {}): MessageListProps {
  return {
    units: [single(textMsg("m1"))],
    activeSessionId: "s1",
    inTurn: false,
    askRequests: [],
    prompts: [],
    stackedAskRequests: [],
    childGates: [],
    hasPendingRequest: false,
    workingOrInTurn: false,
    agentState: "idle",
    turnDiffs: [],
    stopReason: undefined,
    hasMore: false,
    loadingMore: false,
    generation: 0,
    onStartReached: vi.fn(),
    ...overrides,
  };
}

describe("MessageList scroll behavior", () => {
  beforeEach(() => {
    stubRaf();
    virtuosoHandleRef.scrollToIndex.mockClear();
    virtuosoHandleRef.autoscrollToBottom.mockClear();
    capturedVirtuosoProps = null;
  });

  it("4a: wires startReached prop to onStartReached", () => {
    const onStartReached = vi.fn();
    render(<MessageList {...makeProps({ onStartReached })} />);

    expect(capturedVirtuosoProps).not.toBeNull();
    expect(typeof capturedVirtuosoProps.startReached).toBe("function");

    capturedVirtuosoProps.startReached();
    expect(onStartReached).toHaveBeenCalledTimes(1);
  });

  it("4b: computeItemKey(index) returns unique, stable keys when firstItemIndex !== 0 and does not return :undefined", () => {
    const u1 = single(textMsg("m1", "one"));
    const u2 = single(textMsg("m2", "two"));
    const u3 = single(textMsg("m3", "three"));

    render(
      <MessageList
        {...makeProps({
          units: [u1, u2, u3],
          activeSessionId: "sess-abc",
        })}
      />,
    );

    const firstIndex = capturedVirtuosoProps.firstItemIndex;
    expect(firstIndex).toBeGreaterThan(0);

    const key0 = capturedVirtuosoProps.computeItemKey(firstIndex);
    const key1 = capturedVirtuosoProps.computeItemKey(firstIndex + 1);
    const key2 = capturedVirtuosoProps.computeItemKey(firstIndex + 2);

    expect(key0).toBe("sess-abc:text:m1");
    expect(key1).toBe("sess-abc:text:m2");
    expect(key2).toBe("sess-abc:text:m3");

    expect(key0).not.toContain("undefined");
    expect(key1).not.toContain("undefined");
    expect(key2).not.toContain("undefined");

    const uniqueKeys = new Set([key0, key1, key2]);
    expect(uniqueKeys.size).toBe(3);

    // itemContent returns null when unit is undefined
    expect(capturedVirtuosoProps.itemContent(firstIndex, undefined)).toBeNull();
  });

  it("4c (REGRESSION): re-render with same gate counts but MORE units (prepend and append) does NOT call scrollToIndex", () => {
    const u2 = single(textMsg("m2", "two"));
    const u3 = single(textMsg("m3", "three"));

    const { rerender } = render(
      <MessageList {...makeProps({ units: [u2, u3] })} />,
    );

    // Drain initial mount rAF / calls
    flushRaf();
    virtuosoHandleRef.scrollToIndex.mockClear();

    // 1. Prepend older units with the same gate counts
    const u0 = single(textMsg("m0", "zero"));
    const u1 = single(textMsg("m1", "one"));
    rerender(
      <MessageList {...makeProps({ units: [u0, u1, u2, u3] })} />,
    );

    flushRaf();
    expect(
      virtuosoHandleRef.scrollToIndex,
      "scrollToIndex must NOT be called on prepend when gate counts are unchanged",
    ).not.toHaveBeenCalled();

    // 2. Live append of non-user message when user is NOT at bottom
    capturedVirtuosoProps.atBottomStateChange(false);
    virtuosoHandleRef.scrollToIndex.mockClear();

    const u4 = single(textMsg("m4", "four"));
    rerender(
      <MessageList {...makeProps({ units: [u0, u1, u2, u3, u4] })} />,
    );

    flushRaf();
    expect(
      virtuosoHandleRef.scrollToIndex,
      "scrollToIndex must NOT be called on append when not at bottom and gate counts are unchanged",
    ).not.toHaveBeenCalled();
  });

  it("4d: gate-count change calls scrollToIndex({ index: 'LAST', align: 'end' }) one frame later (not synchronously)", () => {
    const { rerender } = render(<MessageList {...makeProps({ prompts: [] })} />);
    flushRaf();
    virtuosoHandleRef.scrollToIndex.mockClear();

    const prompt1: PermissionPromptData = {
      requestId: "p1",
      toolTitle: "Run command",
      options: [{ optionId: "allow", name: "Allow" }],
    };

    rerender(<MessageList {...makeProps({ prompts: [prompt1] })} />);

    // Must NOT have called scrollToIndex synchronously
    expect(virtuosoHandleRef.scrollToIndex).not.toHaveBeenCalled();

    // Must call it after one animation frame
    act(() => {
      flushRaf();
    });

    expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
    });
  });

  it("4e: tailSig change calls scrollToIndex when at bottom and does NOT when not at bottom", () => {
    const { rerender } = render(
      <MessageList {...makeProps({ units: [single(textMsg("m1", "hel"))] })} />,
    );
    flushRaf();
    virtuosoHandleRef.scrollToIndex.mockClear();

    // Default atBottomRef is true
    rerender(
      <MessageList {...makeProps({ units: [single(textMsg("m1", "hello"))] })} />,
    );
    expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
    });

    // Report user scrolled up (atBottom = false)
    act(() => {
      capturedVirtuosoProps.atBottomStateChange(false);
    });
    virtuosoHandleRef.scrollToIndex.mockClear();

    // Re-render with streaming tail growth
    rerender(
      <MessageList
        {...makeProps({ units: [single(textMsg("m1", "hello world"))] })}
      />,
    );
    expect(virtuosoHandleRef.scrollToIndex).not.toHaveBeenCalled();
  });

  it("4f: a new trailing user unit calls scrollToIndex even when not at bottom; re-rendering with same last user unit does not call again", () => {
    const { rerender } = render(
      <MessageList {...makeProps({ units: [single(textMsg("m1", "hello"))] })} />,
    );
    flushRaf();

    // Mark not at bottom
    act(() => {
      capturedVirtuosoProps.atBottomStateChange(false);
    });
    virtuosoHandleRef.scrollToIndex.mockClear();

    // Append new trailing user message
    rerender(
      <MessageList
        {...makeProps({
          units: [
            single(textMsg("m1", "hello")),
            single(userMsg("prompt 1", 100)),
          ],
        })}
      />,
    );

    expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
    });

    virtuosoHandleRef.scrollToIndex.mockClear();

    // Re-rendering with the same last user unit (e.g. other prop changes)
    rerender(
      <MessageList
        {...makeProps({
          inTurn: true,
          units: [
            single(textMsg("m1", "hello")),
            single(userMsg("prompt 1", 100)),
          ],
        })}
      />,
    );

    expect(virtuosoHandleRef.scrollToIndex).not.toHaveBeenCalled();
  });

  it("4g: firstItemIndex decreases on prepend and resets to 100000 on generation change", () => {
    const u2 = single(textMsg("m2", "two"));
    const u3 = single(textMsg("m3", "three"));

    const { rerender } = render(
      <MessageList {...makeProps({ units: [u2, u3], generation: 0 })} />,
    );

    expect(capturedVirtuosoProps.firstItemIndex).toBe(100_000);

    // Prepend 2 units
    const u0 = single(textMsg("m0", "zero"));
    const u1 = single(textMsg("m1", "one"));
    rerender(
      <MessageList
        {...makeProps({ units: [u0, u1, u2, u3], generation: 0 })}
      />,
    );

    expect(capturedVirtuosoProps.firstItemIndex).toBe(99_998);

    // Generation change resets to 100000
    rerender(
      <MessageList
        {...makeProps({ units: [u0, u1, u2, u3], generation: 1 })}
      />,
    );

    expect(capturedVirtuosoProps.firstItemIndex).toBe(100_000);
  });

  it("4h: empty branch (units = []) renders plain scroll div and gate-count change writes scrollTop immediately", () => {
    const { container, rerender } = render(
      <MessageList {...makeProps({ units: [], prompts: [] })} />,
    );

    const scrollEl = container.querySelector(
      '[data-testid="transcript-scroll"]',
    ) as HTMLElement;
    expect(scrollEl).not.toBeNull();
    // Virtuoso stand-in must not be rendered
    expect(container.querySelector('[data-testid="virtuoso-stand-in"]')).toBeNull();

    let writtenScrollTop: number | undefined;
    Object.defineProperty(scrollEl, "scrollHeight", {
      configurable: true,
      get: () => 789,
    });
    Object.defineProperty(scrollEl, "scrollTop", {
      configurable: true,
      get: () => 0,
      set: (v: number) => {
        writtenScrollTop = v;
      },
    });

    const prompt1: PermissionPromptData = {
      requestId: "p1",
      toolTitle: "Run command",
      options: [{ optionId: "allow", name: "Allow" }],
    };

    rerender(
      <MessageList {...makeProps({ units: [], prompts: [prompt1] })} />,
    );

    // Writes scrollTop immediately (without waiting for rAF)
    expect(writtenScrollTop).toBe(789);
  });

  it("4i: resets atBottomRef on generation or activeSessionId change so tailSig follow resumes after remount", () => {
    const { rerender } = render(
      <MessageList
        {...makeProps({
          units: [single(textMsg("m1", "hello"))],
          activeSessionId: "s1",
          generation: 0,
        })}
      />,
    );
    flushRaf();
    virtuosoHandleRef.scrollToIndex.mockClear();

    // User scrolled up (atBottom = false)
    act(() => {
      capturedVirtuosoProps.atBottomStateChange(false);
    });

    // Verify tailSig changes do not scroll while scrolled up
    rerender(
      <MessageList
        {...makeProps({
          units: [single(textMsg("m1", "hello world"))],
          activeSessionId: "s1",
          generation: 0,
        })}
      />,
    );
    expect(virtuosoHandleRef.scrollToIndex).not.toHaveBeenCalled();

    // Generation change (remount) resets atBottomRef to true
    rerender(
      <MessageList
        {...makeProps({
          units: [single(textMsg("m1", "hello world"))],
          activeSessionId: "s1",
          generation: 1,
        })}
      />,
    );

    // Now tailSig change (growing last agent-text) DOES scroll
    rerender(
      <MessageList
        {...makeProps({
          units: [single(textMsg("m1", "hello world!"))],
          activeSessionId: "s1",
          generation: 1,
        })}
      />,
    );

    expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
    });

    // Also verify activeSessionId change resets atBottomRef
    act(() => {
      capturedVirtuosoProps.atBottomStateChange(false);
    });
    virtuosoHandleRef.scrollToIndex.mockClear();

    // Change activeSessionId without changing tailSig yet
    rerender(
      <MessageList
        {...makeProps({
          units: [single(textMsg("m1", "hello world!"))],
          activeSessionId: "s2",
          generation: 0,
        })}
      />,
    );
    expect(virtuosoHandleRef.scrollToIndex).not.toHaveBeenCalled();

    // Now change tailSig (grow last agent-text)
    rerender(
      <MessageList
        {...makeProps({
          units: [single(textMsg("m1", "hello world!!"))],
          activeSessionId: "s2",
          generation: 0,
        })}
      />,
    );

    expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
    });
  });
});
