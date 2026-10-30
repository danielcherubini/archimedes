import { useImperativeHandle } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, act, screen, fireEvent } from "@testing-library/react";
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
      <div
        ref={(el) => {
          if (typeof props.scrollerRef === "function") {
            props.scrollerRef(el);
          }
        }}
        tabIndex={props.tabIndex ?? -1}
        data-testid="virtuoso-stand-in"
        className={props.className}
        onScroll={props.onScroll}
      >
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

function simulateScrollUp(container: HTMLElement) {
  const scroller =
    container.querySelector('[data-testid="virtuoso-stand-in"]') ??
    container.querySelector('[data-testid="transcript-scroll"]') ??
    container.firstElementChild!;
  const target = scroller.firstElementChild ?? scroller;
  fireEvent.wheel(target, { deltaY: -50 });
}

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

    const { container, rerender } = render(
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
    act(() => {
      simulateScrollUp(container);
    });
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
    const { container, rerender } = render(
      <MessageList {...makeProps({ units: [single(textMsg("m1", "hel"))] })} />,
    );
    flushRaf();
    virtuosoHandleRef.scrollToIndex.mockClear();

    // Default atBottom is true
    rerender(
      <MessageList {...makeProps({ units: [single(textMsg("m1", "hello"))] })} />,
    );
    expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledWith({
      index: "LAST",
      align: "end",
    });

    // Report user scrolled up
    act(() => {
      simulateScrollUp(container);
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
    const { container, rerender } = render(
      <MessageList {...makeProps({ units: [single(textMsg("m1", "hello"))] })} />,
    );
    flushRaf();

    // Mark not at bottom
    act(() => {
      simulateScrollUp(container);
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

  it("4i: resets bottom-lock on generation or activeSessionId change so tailSig follow resumes after remount", () => {
    const { container, rerender } = render(
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

    // User scrolled up
    act(() => {
      simulateScrollUp(container);
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

    // Generation change (remount) resets bottom-lock to true
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

    // Also verify activeSessionId change resets bottom-lock
    act(() => {
      simulateScrollUp(container);
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

  describe("bottom-lock and floating 'Scroll to bottom' button", () => {
    it("bottom-lock active by default: floating button is NOT visible and followOutput(true) === 'auto'", () => {
      render(<MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />);
      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe("auto");
      expect(capturedVirtuosoProps.followOutput(false)).toBe(false);
    });

    it("when user scrolls up (e.g. wheel up): floating button becomes visible and followOutput(true) === false", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );
      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();

      act(() => {
        simulateScrollUp(container);
      });

      const button = screen.getByRole("button", { name: /scroll to bottom/i });
      expect(button).not.toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe(false);
    });

    it("clicking floating button calls scrollToIndex('LAST', 'end'), re-engages bottom-lock (followOutput(true) === 'auto'), and hides button", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );

      act(() => {
        simulateScrollUp(container);
      });

      const button = screen.getByRole("button", { name: /scroll to bottom/i });
      expect(button).not.toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe(false);

      virtuosoHandleRef.scrollToIndex.mockClear();

      act(() => {
        button.click();
      });

      expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledWith({
        index: "LAST",
        align: "end",
      });
      expect(capturedVirtuosoProps.followOutput(true)).toBe("auto");
      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
    });

    it("when atBottomStateChange(true) fires (user reaches bottom): floating button dismisses and followOutput(true) === 'auto'", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );

      act(() => {
        simulateScrollUp(container);
      });
      expect(screen.getByRole("button", { name: /scroll to bottom/i })).not.toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe(false);

      act(() => {
        capturedVirtuosoProps.atBottomStateChange(true);
      });
      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe("auto");
    });

    it("submitting a new user message re-engages bottom-lock (followOutput(true) === 'auto') and hides button", () => {
      const { container, rerender } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );

      act(() => {
        simulateScrollUp(container);
      });
      expect(screen.getByRole("button", { name: /scroll to bottom/i })).not.toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe(false);

      // Submit user message
      rerender(
        <MessageList
          {...makeProps({
            units: [
              single(textMsg("m1")),
              single(userMsg("send message", 123)),
            ],
          })}
        />,
      );

      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe("auto");
    });

    it("streaming tail updates auto-scroll after re-engaging bottom-lock via floating button", () => {
      const { container, rerender } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1", "hel"))] })} />,
      );
      flushRaf();

      act(() => {
        simulateScrollUp(container);
      });

      const button = screen.getByRole("button", { name: /scroll to bottom/i });
      act(() => {
        button.click();
      });
      virtuosoHandleRef.scrollToIndex.mockClear();

      // New streaming tail delta
      rerender(
        <MessageList {...makeProps({ units: [single(textMsg("m1", "hello"))] })} />,
      );

      expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledWith({
        index: "LAST",
        align: "end",
      });
    });

    it("session switch starts locked with button hidden and followOutput(true) === 'auto'", () => {
      const { container, rerender } = render(
        <MessageList
          {...makeProps({
            units: [single(textMsg("m1"))],
            activeSessionId: "sess-1",
          })}
        />,
      );

      act(() => {
        simulateScrollUp(container);
      });
      expect(screen.getByRole("button", { name: /scroll to bottom/i })).not.toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe(false);

      // Switch session
      rerender(
        <MessageList
          {...makeProps({
            units: [single(textMsg("m2"))],
            activeSessionId: "sess-2",
          })}
        />,
      );

      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe("auto");
    });

    it("does not render floating button when units list is empty", () => {
      render(<MessageList {...makeProps({ units: [] })} />);
      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
    });

    it("handleScroll: scrollTop decrease with distance <= 80 does not unlock", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );
      const scroller = container.querySelector(
        '[data-testid="virtuoso-stand-in"]',
      ) as HTMLElement;

      Object.defineProperty(scroller, "clientHeight", { value: 500, configurable: true });
      Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });

      // Establish baseline scrollTop at the very bottom: scrollTop = 500 (distance = 0)
      fireEvent.scroll(scroller, { target: { scrollTop: 500 } });
      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe("auto");

      // Minor upward scroll within 80px threshold: scrollTop = 450 (distanceFromBottom = 1000 - (450 + 500) = 50 <= 80)
      fireEvent.scroll(scroller, { target: { scrollTop: 450 } });

      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe("auto");
    });

    it("handleScroll: scrollTop decrease with distance > 80 unlocks and shows button", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );
      const scroller = container.querySelector(
        '[data-testid="virtuoso-stand-in"]',
      ) as HTMLElement;

      Object.defineProperty(scroller, "clientHeight", { value: 500, configurable: true });
      Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });

      // Establish baseline scrollTop: scrollTop = 500 (distance = 0)
      fireEvent.scroll(scroller, { target: { scrollTop: 500 } });
      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();

      // Upward scroll exceeding 80px threshold: scrollTop = 300 (distanceFromBottom = 1000 - (300 + 500) = 200 > 80)
      fireEvent.scroll(scroller, { target: { scrollTop: 300 } });

      expect(screen.getByRole("button", { name: /scroll to bottom/i })).not.toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe(false);
    });

    it("touch-drag down (deltaY > 5 and distance > 80) unlocks and shows button", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );
      const scroller = container.querySelector(
        '[data-testid="virtuoso-stand-in"]',
      ) as HTMLElement;

      Object.defineProperty(scroller, "clientHeight", { value: 500, configurable: true });
      Object.defineProperty(scroller, "scrollHeight", { value: 1000, configurable: true });
      Object.defineProperty(scroller, "scrollTop", { value: 300, configurable: true });

      const wrapper = container.firstElementChild!;

      act(() => {
        fireEvent.touchStart(wrapper, {
          touches: [{ clientY: 100 }],
        });
        fireEvent.touchMove(wrapper, {
          touches: [{ clientY: 200 }],
        });
        fireEvent.touchEnd(wrapper);
      });

      expect(screen.getByRole("button", { name: /scroll to bottom/i })).not.toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe(false);
    });

    it("short transcript wheel-up does not unlock or show button", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );
      const scroller = container.querySelector(
        '[data-testid="virtuoso-stand-in"]',
      ) as HTMLElement;
      expect(scroller).not.toBeNull();

      Object.defineProperty(scroller, "clientHeight", {
        value: 600,
        configurable: true,
      });
      Object.defineProperty(scroller, "scrollHeight", {
        value: 200,
        configurable: true,
      });

      // Mark isAtBottomRef false so wheel-up would unlock unless the short transcript guard holds
      act(() => {
        capturedVirtuosoProps.atBottomStateChange(false);
      });

      act(() => {
        simulateScrollUp(container);
      });

      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe("auto");
    });

    it("rapid streaming growth with atBottomStateChange(false) followed by tailSig change continues to trigger scrollToIndex while locked", () => {
      const { rerender } = render(
        <MessageList
          {...makeProps({ units: [single(textMsg("m1", "hello"))] })}
        />,
      );
      flushRaf();
      virtuosoHandleRef.scrollToIndex.mockClear();

      act(() => {
        capturedVirtuosoProps.atBottomStateChange(false);
      });

      expect(capturedVirtuosoProps.followOutput(true)).toBe("auto");
      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();

      rerender(
        <MessageList
          {...makeProps({ units: [single(textMsg("m1", "hello world"))] })}
        />,
      );

      expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledTimes(1);
      expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledWith({
        index: "LAST",
        align: "end",
      });
    });

    it("button click blurs/moves focus and scrolls to bottom", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );

      act(() => {
        simulateScrollUp(container);
      });

      const button = screen.getByRole("button", { name: /scroll to bottom/i });
      expect(button).not.toBeNull();

      button.focus();
      expect(document.activeElement).toBe(button);

      virtuosoHandleRef.scrollToIndex.mockClear();

      act(() => {
        button.click();
      });

      expect(virtuosoHandleRef.scrollToIndex).toHaveBeenCalledWith({
        index: "LAST",
        align: "end",
      });
      const scroller = container.querySelector(
        '[data-testid="virtuoso-stand-in"]',
      );
      expect(document.activeElement).toBe(scroller);
      expect(document.activeElement).not.toBe(document.body);
      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
    });

    it("wheel inside a nested scrollable element does not unlock or show button", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );
      const scroller = container.querySelector(
        '[data-testid="virtuoso-stand-in"]',
      ) as HTMLElement;

      const nested = document.createElement("div");
      nested.className = "overflow-y-auto";
      Object.defineProperty(nested, "clientHeight", { value: 100, configurable: true });
      Object.defineProperty(nested, "scrollHeight", { value: 300, configurable: true });
      nested.scrollTop = 50;
      scroller.appendChild(nested);

      act(() => {
        fireEvent.wheel(nested, { deltaY: -50 });
      });

      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe("auto");
    });

    it("wheel inside a nested scrollable element on an SVG target does not unlock", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );
      const scroller = container.querySelector(
        '[data-testid="virtuoso-stand-in"]',
      ) as HTMLElement;

      const nested = document.createElement("div");
      nested.className = "overflow-y-auto";
      Object.defineProperty(nested, "clientHeight", { value: 100, configurable: true });
      Object.defineProperty(nested, "scrollHeight", { value: 300, configurable: true });
      nested.scrollTop = 50;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      svg.appendChild(path);
      nested.appendChild(svg);
      scroller.appendChild(nested);

      act(() => {
        fireEvent.wheel(path, { deltaY: -50 });
      });

      expect(screen.queryByRole("button", { name: /scroll to bottom/i })).toBeNull();
      expect(capturedVirtuosoProps.followOutput(true)).toBe("auto");
    });

    it("handleWheel and handleTouchMove early-exit when already unlocked", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );
      const scroller = container.querySelector(
        '[data-testid="virtuoso-stand-in"]',
      ) as HTMLElement;
      expect(scroller).not.toBeNull();

      Object.defineProperty(scroller, "clientHeight", {
        value: 600,
        configurable: true,
      });
      Object.defineProperty(scroller, "scrollHeight", {
        value: 2000,
        configurable: true,
      });

      // Target an element inside the scroller
      const innerTarget = (scroller.firstElementChild ?? scroller) as HTMLElement;

      // Unlock first
      act(() => {
        simulateScrollUp(container);
      });
      expect(capturedVirtuosoProps.followOutput(true)).toBe(false);

      const getComputedStyleSpy = vi.spyOn(window, "getComputedStyle");
      getComputedStyleSpy.mockClear();

      act(() => {
        fireEvent.wheel(innerTarget, { deltaY: -50 });
        fireEvent.touchStart(innerTarget, { touches: [{ clientY: 100 }] });
        fireEvent.touchMove(innerTarget, { touches: [{ clientY: 200 }] });
      });

      expect(getComputedStyleSpy).not.toHaveBeenCalled();
      getComputedStyleSpy.mockRestore();
    });

    it("floating button has accessible attributes, no duplicate hover class, and ChevronDown has aria-hidden='true'", () => {
      const { container } = render(
        <MessageList {...makeProps({ units: [single(textMsg("m1"))] })} />,
      );

      act(() => {
        simulateScrollUp(container);
      });

      const button = screen.getByTestId("scroll-to-bottom-button");
      expect(button.getAttribute("type")).toBe("button");
      expect(button.getAttribute("aria-label")).toBe("Scroll to bottom");
      expect(button.className).not.toContain("hover:text-foreground");

      const icon = button.querySelector("svg");
      expect(icon).not.toBeNull();
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
    });
  });
});
