/**
 * The shared `prefers-reduced-motion` hook.
 *
 * Two environments matter and both are asserted here:
 *
 *  1. A runtime WITH `matchMedia` (a browser, or the stub below): the hook seeds
 *     `false`, learns the truth in an effect, and re-renders when the query's
 *     `change` event fires — the OS preference can flip while the app is open.
 *  2. jsdom's REAL state, where `window.matchMedia` does not exist at all: the
 *     hook answers `false` and does not throw. That guard is the only reason the
 *     components that call this are renderable under test, so the second case is
 *     not a formality — it is the contract `braille-loader.tsx`'s own copy
 *     exists to satisfy too.
 *
 * The `matchMedia` stub is the same shape `braille-loader.test.tsx` uses: the
 * hook calls `addEventListener`/`removeEventListener` on the `MediaQueryList`,
 * so a bare `{ matches }` object throws.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

interface FakeMediaQueryList {
  matches: boolean;
  media: string;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  listeners: Array<() => void>;
}

const registry: FakeMediaQueryList[] = [];

/**
 * Install a `window.matchMedia` stub whose query objects record their listeners
 * and can be flipped + fired by `setMatches`, so the `change` path is asserted
 * for real rather than assumed.
 */
function installMatchMediaStub(reduced: boolean) {
  registry.length = 0;
  const impl = ((query: string): MediaQueryList => {
    const matches = query === "(prefers-reduced-motion: reduce)" ? reduced : false;
    const mql = {
      matches,
      media: query,
      addEventListener: vi.fn((_type: string, listener: () => void) => {
        mql.listeners.push(listener);
      }),
      removeEventListener: vi.fn(),
      listeners: [] as Array<() => void>,
    };
    registry.push(mql as unknown as FakeMediaQueryList);
    return mql as unknown as MediaQueryList;
  }) as unknown as (query: string) => MediaQueryList;
  // jsdom does not implement window.matchMedia — provide the function first so
  // vi.spyOn has something to wrap.
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = impl;
  }
  return vi.spyOn(window, "matchMedia").mockImplementation(impl);
}

/** Flip the stub's answer and dispatch `change`, as an OS preference toggle would. */
function emitChange(matches: boolean) {
  const mql = registry[0];
  if (mql === undefined) throw new Error("no MediaQueryList was created");
  mql.matches = matches;
  act(() => {
    mql.listeners.forEach((listener) => {
      listener();
    });
  });
}

describe("usePrefersReducedMotion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    registry.length = 0;
  });

  it("returns true when the query matches", () => {
    installMatchMediaStub(true);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
  });

  it("returns false when the query does not match", () => {
    installMatchMediaStub(false);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });

  it("re-renders when the media query fires change", () => {
    installMatchMediaStub(false);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
    emitChange(true);
    expect(result.current).toBe(true);
    emitChange(false);
    expect(result.current).toBe(false);
  });

  it("unsubscribes from the change event on unmount", () => {
    installMatchMediaStub(false);
    const { unmount } = renderHook(() => usePrefersReducedMotion());
    const mql = registry[0];
    expect(mql?.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    unmount();
    expect(mql?.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("uses addListener when the legacy API is all the query offers", () => {
    // WebKitGTK-era MediaQueryList: no addEventListener, only addListener.
    const listeners: Array<() => void> = [];
    const addListener = vi.fn((_type: string, listener: () => void) => {
      listeners.push(listener);
    });
    const removeListener = vi.fn();
    const impl = ((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      addListener,
      removeListener,
    })) as unknown as (query: string) => MediaQueryList;
    if (typeof window.matchMedia !== "function") window.matchMedia = impl;
    vi.spyOn(window, "matchMedia").mockImplementation(impl);

    const { result, unmount } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
    expect(addListener).toHaveBeenCalledWith(expect.any(Function));
    unmount();
    expect(removeListener).toHaveBeenCalledWith(expect.any(Function));
  });

  it("returns false and does not throw when window.matchMedia is absent", () => {
    // jsdom's real state — delete whatever a previous test installed.
    delete (window as { matchMedia?: unknown }).matchMedia;
    expect(typeof window.matchMedia).not.toBe("function");
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });
});
