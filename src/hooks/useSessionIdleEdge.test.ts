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
    renderHook(() => useSessionIdleEdge({ key: "s1", busy: false, onIdle }));
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("a first render with busy=true fires nothing", () => {
    const onIdle = vi.fn();
    renderHook(() => useSessionIdleEdge({ key: "s1", busy: true, onIdle }));
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("false → true fires nothing (rising is not idling)", () => {
    const onIdle = vi.fn();
    const { rerender } = renderHook(
      ({ busy }: { busy: boolean }) =>
        useSessionIdleEdge({ key: "s1", busy, onIdle }),
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
      ({ busy }: { busy: boolean }) =>
        useSessionIdleEdge({ key: "s1", busy, onIdle }),
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
      ({ busy }: { busy: boolean }) =>
        useSessionIdleEdge({ key: "s1", busy, onIdle }),
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
      ({ busy }: { busy: boolean }) =>
        useSessionIdleEdge({ key: "s1", busy, onIdle }),
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
      useSessionIdleEdge({ key: "s1", busy: false, onIdle: first }),
    );
    unmount();
    const onIdle = vi.fn();
    renderHook(() => useSessionIdleEdge({ key: "s1", busy: false, onIdle }));
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("remounting while busy=true, then going idle, fires once", () => {
    const { unmount } = renderHook(() =>
      useSessionIdleEdge({ key: "s1", busy: true, onIdle: vi.fn() }),
    );
    unmount();
    const onIdle = vi.fn();
    const { rerender } = renderHook(
      ({ busy }: { busy: boolean }) =>
        useSessionIdleEdge({ key: "s1", busy, onIdle }),
      { initialProps: { busy: true } },
    );
    expect(onIdle).not.toHaveBeenCalled();
    act(() => {
      rerender({ busy: false });
    });
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("a key change with busy going true → false fires NOTHING (a Session switch is not a fall)",
    () => {
      // THE H1 PIN. The hook is handed ONE boolean — `composerLocked` of the
      // Session that happens to be on screen — so a tab switch can move it
      // `true → false` in a single render: the session you LEAVE was mid-turn,
      // the one you ARRIVE at is idle. Measured across two different Sessions
      // that is not a fall, and `flushHead` reads `activeSessionIdRef.current`
      // — already the NEW session — so firing here dispatches a queued prompt
      // with no user gesture at all. A change of SUBJECT never is an edge.
      const onIdle = vi.fn();
      const { rerender } = renderHook(
        ({ key, busy }: { key: string; busy: boolean }) =>
          useSessionIdleEdge({ key, busy, onIdle }),
        { initialProps: { key: "s1", busy: true } },
      );
      act(() => {
        rerender({ key: "s2", busy: false });
      });
      expect(onIdle).not.toHaveBeenCalled();
    });

  it("a key change RE-SEEDS: a real fall inside the new key still fires", () => {
    // The other half of the rule — declining the switch is not declining the
    // Session. After the re-seed the hook must be watching the new Session
    // normally, so its OWN busy→idle fall (a turn that ends while it is on
    // screen) fires exactly once.
    const onIdle = vi.fn();
    const { rerender } = renderHook(
      ({ key, busy }: { key: string; busy: boolean }) =>
        useSessionIdleEdge({ key, busy, onIdle }),
      { initialProps: { key: "s1", busy: true } },
    );
    // The switch: no edge.
    act(() => {
      rerender({ key: "s2", busy: false });
    });
    expect(onIdle).not.toHaveBeenCalled();
    // … and now a level, not an edge (idle staying idle).
    act(() => {
      rerender({ key: "s2", busy: false });
    });
    expect(onIdle).not.toHaveBeenCalled();
    // The new Session starts a turn and settles it — THAT is the fall.
    act(() => {
      rerender({ key: "s2", busy: true });
    });
    act(() => {
      rerender({ key: "s2", busy: false });
    });
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("a key change with busy staying true fires nothing, and the new key's fall fires",
    () => {
      // Busy → busy across a switch: no edge either way, and the re-seed must
      // leave the hook armed for the new Session's own settle.
      const onIdle = vi.fn();
      const { rerender } = renderHook(
        ({ key, busy }: { key: string; busy: boolean }) =>
          useSessionIdleEdge({ key, busy, onIdle }),
        { initialProps: { key: "s1", busy: true } },
      );
      act(() => {
        rerender({ key: "s2", busy: true });
      });
      expect(onIdle).not.toHaveBeenCalled();
      act(() => {
        rerender({ key: "s2", busy: false });
      });
      expect(onIdle).toHaveBeenCalledTimes(1);
    });

  it("a key change while idle → idle fires nothing (the empty/no-session key is stable)",
    () => {
      // `ChatStream` passes `key: activeSessionId ?? ""`, so the no-session
      // frame carries `""`. A level of idle on both sides of a key change must
      // not be read as a fall.
      const onIdle = vi.fn();
      const { rerender } = renderHook(
        ({ key, busy }: { key: string; busy: boolean }) =>
          useSessionIdleEdge({ key, busy, onIdle }),
        { initialProps: { key: "", busy: false } },
      );
      act(() => {
        rerender({ key: "s1", busy: false });
      });
      act(() => {
        rerender({ key: "", busy: false });
      });
      expect(onIdle).not.toHaveBeenCalled();
    });

  it("remounting on a new key with busy=false fires nothing (seed covers both)", () => {
    // A remount AND a key change at once — the shape `SettingsPage` produces
    // when the active Session differs across the unmount. Both rules say the
    // same thing: seed, don't fire.
    const { unmount } = renderHook(() =>
      useSessionIdleEdge({ key: "s1", busy: true, onIdle: vi.fn() }),
    );
    unmount();
    const onIdle = vi.fn();
    renderHook(() => useSessionIdleEdge({ key: "s2", busy: false, onIdle }));
    expect(onIdle).not.toHaveBeenCalled();
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
        useSessionIdleEdge({ key: "s1", busy, onIdle: () => seen.push(label) }),
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
