import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSessionIdleEdge } from "./useSessionIdleEdge";

/**
 * The **Flush** trigger. Every assertion here is about ONE thing: the callback
 * fires on the falling edge of `busy` and on nothing else — not on the first
 * render of an idle Session, not on a rise, not twice for one fall.
 */
describe("useSessionIdleEdge (the busy→idle fall that Flushes the queue head)", () => {
  it("a first render with busy=false fires nothing (an already-idle mount is not an edge)", () => {
    const onIdle = vi.fn();
    renderHook(() => useSessionIdleEdge({ busy: false, onIdle }));
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("a first render with busy=true fires nothing", () => {
    const onIdle = vi.fn();
    renderHook(() => useSessionIdleEdge({ busy: true, onIdle }));
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("false → true fires nothing (rising is not idling)", () => {
    const onIdle = vi.fn();
    const { rerender } = renderHook(
      ({ busy }: { busy: boolean }) => useSessionIdleEdge({ busy, onIdle }),
      { initialProps: { busy: false } },
    );
    act(() => {
      rerender({ busy: true });
    });
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("false → true → false fires exactly once", () => {
    const onIdle = vi.fn();
    const { rerender } = renderHook(
      ({ busy }: { busy: boolean }) => useSessionIdleEdge({ busy, onIdle }),
      { initialProps: { busy: false } },
    );
    act(() => {
      rerender({ busy: true });
    });
    act(() => {
      rerender({ busy: false });
    });
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("staying idle across re-renders fires nothing more (one edge, one call)", () => {
    const onIdle = vi.fn();
    const { rerender } = renderHook(
      ({ busy }: { busy: boolean }) => useSessionIdleEdge({ busy, onIdle }),
      { initialProps: { busy: false } },
    );
    act(() => {
      rerender({ busy: true });
    });
    act(() => {
      rerender({ busy: false });
    });
    expect(onIdle).toHaveBeenCalledTimes(1);
    // Two further renders of the SAME value (a re-render is not an edge — an
    // unrelated store write must never re-Flush the queue).
    act(() => {
      rerender({ busy: false });
    });
    act(() => {
      rerender({ busy: false });
    });
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("two consecutive busy episodes fire twice (the queue drains one per settle)", () => {
    const onIdle = vi.fn();
    const { rerender } = renderHook(
      ({ busy }: { busy: boolean }) => useSessionIdleEdge({ busy, onIdle }),
      { initialProps: { busy: false } },
    );
    for (const _ of [0, 1]) {
      act(() => {
        rerender({ busy: true });
      });
      act(() => {
        rerender({ busy: false });
      });
    }
    expect(onIdle).toHaveBeenCalledTimes(2);
  });

  it("remounting with busy=false fires nothing (the seed pin: a ref reset re-seeds, it is not an edge)", () => {
    // `App.tsx:424-425` swaps `SettingsPage` in wholesale, so `ChatStream`
    // unmounts and remounts while a Session stays idle. A hook that treated
    // "the module saw busy=true earlier" as a remembered state would Flush a
    // queue here for a settle that happened while the component was gone.
    const first = vi.fn();
    const { unmount } = renderHook(() =>
      useSessionIdleEdge({ busy: false, onIdle: first }),
    );
    unmount();
    const onIdle = vi.fn();
    renderHook(() => useSessionIdleEdge({ busy: false, onIdle }));
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("remounting while busy=true, then going idle, fires once", () => {
    const { unmount } = renderHook(() =>
      useSessionIdleEdge({ busy: true, onIdle: vi.fn() }),
    );
    unmount();
    const onIdle = vi.fn();
    const { rerender } = renderHook(
      ({ busy }: { busy: boolean }) => useSessionIdleEdge({ busy, onIdle }),
      { initialProps: { busy: true } },
    );
    expect(onIdle).not.toHaveBeenCalled();
    act(() => {
      rerender({ busy: false });
    });
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("the edge calls the callback of the CURRENT render, not the one it mounted with", () => {
    // `cb.current` is assigned DURING RENDER, which is why the caller can pass
    // a fresh inline closure each render instead of a `useCallback` with a
    // guessed dep array. Pinning it: a stale `useRef(onIdle)` (write-once at
    // mount) would fire the FIRST render's closure and read a stale `draft` /
    // `imageCapable` — the exact staleness this file's ref mirrors exist to kill.
    const seen: string[] = [];
    const { rerender } = renderHook(
      ({ busy, label }: { busy: boolean; label: string }) =>
        useSessionIdleEdge({ busy, onIdle: () => seen.push(label) }),
      { initialProps: { busy: false, label: "first" } },
    );
    act(() => {
      rerender({ busy: true, label: "second" });
    });
    act(() => {
      rerender({ busy: false, label: "third" });
    });
    expect(seen).toEqual(["third"]);
  });
});
