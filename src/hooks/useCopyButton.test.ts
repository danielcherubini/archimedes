import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COPY_RESET_MS, useCopyButton } from "./useCopyButton";

/**
 * The one copy→confirm machine, asserted directly (before it is shared by the
 * three call sites: `CodeBlock`, `AgentText`, `ToolCallCardHeader`).
 *
 * The render tests are the real behaviour-preservation proof for the markup and
 * the labels (`MessageBubble.test.tsx`, `MessageBubble.codeblock.test.tsx`,
 * `ToolCallCard.test.tsx`); what THIS file owns is the machine itself — the
 * timer arithmetic, the restart-not-stack rule, the nullish no-op, the missing
 * `navigator.clipboard` case, and the rejection branch that the three copied
 * implementations each silently dropped.
 *
 * Everything runs on fake timers: the reset is a wall-clock delay and the tests
 * assert `vi.getTimerCount()`, so a real clock would make both flaky.
 */

/** Install a clipboard stub. jsdom has none, so every test that reaches the
 * clipboard has to provide one; `undefined` is the "no clipboard" case. */
function stubClipboard(writeText: (() => Promise<void>) | undefined) {
  Object.defineProperty(navigator, "clipboard", {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  });
}

/** Let the `writeText().then(...)` continuation run (two microtask hops, the
 * same depth the render tests use for the same continuation). */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useCopyButton", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    stubClipboard(undefined);
  });

  it("starts idle: neither copied nor failed", () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    const { result } = renderHook(() => useCopyButton("hello"));
    expect(result.current.copied).toBe(false);
    expect(result.current.failed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("copy() writes the text and sets copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const { result } = renderHook(() => useCopyButton("the text"));

    act(() => result.current.copy());
    await flush();

    expect(writeText).toHaveBeenCalledWith("the text");
    expect(result.current.copied).toBe(true);
    expect(result.current.failed).toBe(false);
  });

  it("resets copied after exactly COPY_RESET_MS (1ms early still confirms)", async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    const { result } = renderHook(() => useCopyButton("the text"));

    act(() => result.current.copy());
    await flush();
    expect(result.current.copied).toBe(true);
    // The claim is the RESET, so a reset must actually be scheduled — and only
    // ONE timer, which is what distinguishes this from a stacking implementation.
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(COPY_RESET_MS - 1);
      await Promise.resolve();
    });
    expect(result.current.copied).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(result.current.copied).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a second click REPLACES the pending reset instead of stacking timers", async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    const { result } = renderHook(() => useCopyButton("the text"));

    act(() => result.current.copy());
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(result.current.copied).toBe(true);

    act(() => result.current.copy());
    await flush();
    expect(vi.getTimerCount()).toBe(1);

    // 1000ms after the SECOND click (2000 total) it is still confirming — a
    // double-scheduled implementation would have flipped back at 1500 total.
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(result.current.copied).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(COPY_RESET_MS - 1000);
      await Promise.resolve();
    });
    expect(result.current.copied).toBe(false);
  });

  it("COPY_RESET_MS is the 1.5s the three call sites documented", () => {
    expect(COPY_RESET_MS).toBe(1500);
  });

  it("nullish or empty text makes copy() a no-op (writeText never called)", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    for (const text of [undefined, null, ""]) {
      const { result, unmount } = renderHook(() => useCopyButton(text));
      act(() => result.current.copy());
      expect(writeText, `text=${String(text)}`).not.toHaveBeenCalled();
      expect(result.current.copied).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      unmount();
    }
  });

  it("a rejected write sets failed, leaves copied false, and still resets", async () => {
    stubClipboard(() => Promise.reject(new Error("denied")));
    const { result } = renderHook(() => useCopyButton("the text"));

    act(() => result.current.copy());
    await flush();

    // The behaviour ADDITION: the three copies each swallowed this rejection and
    // confirmed nothing. `failed` is the state; no visible affordance is wired
    // to it yet (that is a later task's call-site decision).
    expect(result.current.failed).toBe(true);
    expect(result.current.copied).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(COPY_RESET_MS);
      await Promise.resolve();
    });
    expect(result.current.failed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a successful write clears a previous failed", async () => {
    let reject = true;
    stubClipboard(() =>
      reject ? Promise.reject(new Error("denied")) : Promise.resolve(),
    );
    const { result } = renderHook(() => useCopyButton("the text"));

    act(() => result.current.copy());
    await flush();
    expect(result.current.failed).toBe(true);

    reject = false;
    act(() => result.current.copy());
    await flush();
    expect(result.current.failed).toBe(false);
    expect(result.current.copied).toBe(true);
  });

  it("unmount clears the pending reset, so a later advance is inert", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    const { result, unmount } = renderHook(() => useCopyButton("the text"));

    act(() => result.current.copy());
    await flush();
    expect(result.current.copied).toBe(true);
    // Non-vacuity: a timer really is in flight, so the 0 below is the CLEANUP.
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      unmount();
    });
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      vi.advanceTimersByTime(COPY_RESET_MS * 2);
      await Promise.resolve();
    });
    const warnings = errors.mock.calls
      .flat()
      .filter((a) => typeof a === "string" && /unmounted|setState|memory leak/i.test(a));
    expect(warnings).toEqual([]);
  });

  it("a missing navigator.clipboard does not throw and does not confirm", async () => {
    stubClipboard(undefined);
    const { result } = renderHook(() => useCopyButton("the text"));

    act(() => result.current.copy());
    await flush();

    expect(result.current.copied).toBe(false);
    expect(result.current.failed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
